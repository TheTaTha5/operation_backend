export type Deployment = {
  boat_id: string;
  route_id: string;
  service_date: string;
  /** Normal-seat booking capacity. */
  capacity: number;
  license_pax?: number;
  total_capacity?: number;
};

export type BookingStatus = 'confirmed' | 'cancelled';
export type Booking = {
  id: string;
  route_id: string;
  service_date: string;
  pax: number;
  allocated_pax: number;
  status: BookingStatus;
  created_at: string;
  updated_at: string;
  cancellation_reason?: string;
  /** Source-system identifiers and commercial context. */
  external_id?: string;
  agent_id?: string;
  voucher_ref?: string;
  rate_type_ref?: string;
  booking_mode?: string;
  /** Seat categories; infants and FOC passengers are included in allocated pax. */
  pax_breakdown?: Record<string, number>;
  /** Original booking payload retained for operations, reconciliation, and audit import. */
  booking_data?: Record<string, unknown>;
};

export type SeatLock = {
  id: string;
  route_id: string;
  service_date: string;
  pax: number;
  agent_id?: string;
  status: 'active' | 'released';
  created_at: string;
  updated_at: string;
  released_at?: string;
};

type Capacity = { deployed_capacity: number; total_capacity: number; booked_pax: number; charter_pax: number; locked_pax: number; available_seats: number };

/** A small serialized in-memory unit of work. Replace this adapter with a DB transaction in production. */
export class OperationsStore {
  private deployments: Deployment[] = [];
  private bookings = new Map<string, Booking>();
  private locks = new Map<string, SeatLock>();
  private tail: Promise<void> = Promise.resolve();

  async transaction<T>(work: () => T | Promise<T>): Promise<T> {
    const prior = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => { release = resolve; });
    await prior;
    try { return await work(); } finally { release(); }
  }

  private key(routeId: string, serviceDate: string): string { return `${routeId}\u0000${serviceDate}`; }
  private now(): string { return new Date().toISOString(); }
  private id(prefix: string): string { return `${prefix}_${crypto.randomUUID()}`; }

  capacity(routeId: string, serviceDate: string): Capacity {
    const deployed_capacity = this.deployments
      .filter((d) => d.route_id === routeId && d.service_date === serviceDate)
      .reduce((sum, d) => sum + d.capacity, 0);
    const total_capacity = this.deployments
      .filter((d) => d.route_id === routeId && d.service_date === serviceDate)
      .reduce((sum, d) => sum + (d.total_capacity ?? d.capacity), 0);
    const booked_pax = [...this.bookings.values()]
      .filter((b) => b.route_id === routeId && b.service_date === serviceDate && b.status === 'confirmed' && b.booking_mode !== 'charter')
      .reduce((sum, b) => sum + b.allocated_pax, 0);
    const charter_pax = [...this.bookings.values()]
      .filter((b) => b.route_id === routeId && b.service_date === serviceDate && b.status === 'confirmed' && b.booking_mode === 'charter')
      .reduce((sum, b) => sum + b.pax, 0);
    const locked_pax = [...this.locks.values()]
      .filter((l) => l.route_id === routeId && l.service_date === serviceDate && l.status === 'active')
      .reduce((sum, l) => sum + l.pax, 0);
    return { deployed_capacity, total_capacity, booked_pax, charter_pax, locked_pax, available_seats: deployed_capacity - booked_pax - locked_pax };
  }

  private assertCapacity(routeId: string, serviceDate: string, pax: number, charter = false): void {
    const capacity = this.capacity(routeId, serviceDate);
    const available = charter ? capacity.total_capacity - capacity.booked_pax - capacity.charter_pax - capacity.locked_pax : capacity.available_seats;
    if (available < pax) {
      const error = new Error('Insufficient available seats');
      (error as Error & { statusCode: number }).statusCode = 409;
      throw error;
    }
  }

  createDeployment(input: Deployment): Deployment {
    const existing = this.deployments.findIndex((d) => d.boat_id === input.boat_id && d.service_date === input.service_date);
    if (existing >= 0) this.deployments[existing] = { ...input };
    else this.deployments.push({ ...input });
    return { ...input };
  }

  deleteDeployment(serviceDate: string, boatId: string): boolean {
    const index = this.deployments.findIndex((d) => d.service_date === serviceDate && d.boat_id === boatId);
    if (index < 0) return false;
    this.deployments.splice(index, 1);
    return true;
  }

  listDeployments(from?: string, to?: string, routeId?: string): Deployment[] {
    return this.deployments.filter((d) => (!from || d.service_date >= from) && (!to || d.service_date <= to) && (!routeId || d.route_id === routeId));
  }

  createBooking(input: Omit<Booking, 'id' | 'allocated_pax' | 'status' | 'created_at' | 'updated_at'>): Booking {
    this.assertCapacity(input.route_id, input.service_date, input.pax, input.booking_mode === 'charter');
    const now = this.now();
    const booking: Booking = { ...input, id: this.id('booking'), allocated_pax: input.booking_mode === 'charter' ? 0 : input.pax, status: 'confirmed', created_at: now, updated_at: now };
    this.bookings.set(booking.id, booking);
    return { ...booking };
  }

  listBookings(routeId?: string, serviceDate?: string): Booking[] {
    return [...this.bookings.values()].filter((b) => (!routeId || b.route_id === routeId) && (!serviceDate || b.service_date === serviceDate)).map((b) => ({ ...b }));
  }
  booking(id: string): Booking | undefined { const value = this.bookings.get(id); return value && { ...value }; }

  amendBooking(id: string, changes: Partial<Pick<Booking, 'route_id' | 'service_date' | 'pax'>> & Record<string, unknown>): Booking | undefined {
    const booking = this.bookings.get(id);
    if (!booking) return undefined;
    const route_id = typeof changes.route_id === 'string' ? changes.route_id : booking.route_id;
    const service_date = typeof changes.service_date === 'string' ? changes.service_date : booking.service_date;
    const pax = typeof changes.pax === 'number' ? changes.pax : booking.pax;
    if (booking.status === 'confirmed' && (route_id !== booking.route_id || service_date !== booking.service_date || pax !== booking.pax)) {
      // Temporarily remove its prior allocation so an unchanged/amended reservation does not compete with itself.
      booking.allocated_pax = 0;
      try { this.assertCapacity(route_id, service_date, pax); } catch (error) { booking.allocated_pax = booking.pax; throw error; }
      booking.allocated_pax = pax;
    }
    Object.assign(booking, changes, { route_id, service_date, pax, updated_at: this.now() });
    return { ...booking };
  }

  cancelBooking(id: string, reason?: string): Booking | undefined {
    const booking = this.bookings.get(id);
    if (!booking) return undefined;
    if (booking.status === 'confirmed') {
      booking.status = 'cancelled';
      booking.allocated_pax = 0;
      booking.cancellation_reason = reason;
      booking.updated_at = this.now();
    }
    return { ...booking };
  }

  partialCancel(id: string, paxToCancel: number): Booking | undefined {
    const booking = this.bookings.get(id);
    if (!booking) return undefined;
    if (booking.status !== 'confirmed' || paxToCancel > booking.pax) {
      const error = new Error('Cannot cancel more passengers than the active booking');
      (error as Error & { statusCode: number }).statusCode = 400;
      throw error;
    }
    booking.pax -= paxToCancel;
    booking.allocated_pax = booking.pax;
    booking.updated_at = this.now();
    return { ...booking };
  }

  createLock(input: Omit<SeatLock, 'id' | 'status' | 'created_at' | 'updated_at'>): SeatLock {
    this.assertCapacity(input.route_id, input.service_date, input.pax);
    const now = this.now();
    const lock: SeatLock = { ...input, id: this.id('lock'), status: 'active', created_at: now, updated_at: now };
    this.locks.set(lock.id, lock);
    return { ...lock };
  }
  listLocks(routeId?: string, serviceDate?: string): SeatLock[] {
    return [...this.locks.values()].filter((l) => (!routeId || l.route_id === routeId) && (!serviceDate || l.service_date === serviceDate)).map((l) => ({ ...l }));
  }
  amendLock(id: string, changes: Partial<Pick<SeatLock, 'pax' | 'agent_id'>>): SeatLock | undefined {
    const lock = this.locks.get(id);
    if (!lock) return undefined;
    const pax = typeof changes.pax === 'number' ? changes.pax : lock.pax;
    if (lock.status === 'active' && pax !== lock.pax) {
      const old = lock.pax; lock.pax = 0;
      try { this.assertCapacity(lock.route_id, lock.service_date, pax); } catch (error) { lock.pax = old; throw error; }
      lock.pax = pax;
    }
    Object.assign(lock, changes, { pax, updated_at: this.now() });
    return { ...lock };
  }
  releaseLock(id: string): SeatLock | undefined {
    const lock = this.locks.get(id);
    if (!lock) return undefined;
    if (lock.status === 'active') Object.assign(lock, { status: 'released', released_at: this.now(), updated_at: this.now() });
    return { ...lock };
  }

  allotment(routeId: string, serviceDate: string): Capacity & { route_id: string; service_date: string; deployments: Deployment[] } {
    return { route_id: routeId, service_date: serviceDate, ...this.capacity(routeId, serviceDate), deployments: this.listDeployments(serviceDate, serviceDate, routeId) };
  }
}
