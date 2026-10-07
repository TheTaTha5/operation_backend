-- Read-only data check for todo/rate-types-model.md, run 2026-10-07 against production legacy.
-- Run with: PGOPTIONS='-c default_transaction_read_only=on -c search_path=operation_schemas' psql "$ORIGINAL_DATABASE_URL" -f todo/rate-types-data-check.sql

\pset footer off
\echo '== size'
SELECT count(*) AS rate_types, count(*) FILTER (WHERE active IS NOT TRUE) AS not_active,
       count(*) FILTER (WHERE active IS NULL) AS active_null FROM sb_rate_types;
\echo '== duplicate codes (UNIQUE code)'
SELECT code, count(*), string_agg(id, ',') FROM sb_rate_types GROUP BY code HAVING count(*) > 1;
\echo '== empty code / empty name'
SELECT count(*) FILTER (WHERE coalesce(trim(code), '') = '') AS empty_code,
       count(*) FILTER (WHERE coalesce(trim(name), '') = '') AS empty_name FROM sb_rate_types;
\echo '== owner values and orphans (owner FK)'
SELECT coalesce(nullif(owner, ''), '(shared)') AS owner, (owner IN (SELECT id FROM sb_sales)) AS is_sales, count(*)
  FROM sb_rate_types GROUP BY 1, 2 ORDER BY 3 DESC;
\echo '== nationality scope values'
SELECT coalesce(nationalityscope, '(null)') AS scope, count(*) FROM sb_rate_types GROUP BY 1;
\echo '== valid dates: malformed / out of order'
SELECT count(*) FILTER (WHERE coalesce(validfrom, '') <> '' AND validfrom !~ '^\d{4}-\d{2}-\d{2}$') AS bad_from,
       count(*) FILTER (WHERE coalesce(validto, '') <> '' AND validto !~ '^\d{4}-\d{2}-\d{2}$') AS bad_to,
       count(*) FILTER (WHERE coalesce(validfrom, '') <> '' AND coalesce(validto, '') <> '' AND validfrom > validto) AS from_after_to,
       count(*) FILTER (WHERE coalesce(createddate, '') <> '' AND createddate !~ '^\d{4}-\d{2}-\d{2}$') AS bad_created
  FROM sb_rate_types;
\echo '== routes per rate type; route ids not in the catalogue (route FK)'
SELECT count(*) AS route_rows, count(DISTINCT sb_rate_types_id) AS rate_types_with_routes, max(n) AS max_routes
  FROM sb_rate_types__routes, LATERAL (SELECT count(*) n FROM sb_rate_types__routes r2 WHERE r2.sb_rate_types_id = sb_rate_types__routes.sb_rate_types_id) x;
SELECT value AS missing_route, count(*) FROM sb_rate_types__routes WHERE value NOT IN (SELECT id FROM routes) GROUP BY 1;
SELECT sb_rate_types_id, value, count(*) FROM sb_rate_types__routes GROUP BY 1, 2 HAVING count(*) > 1;
\echo '== route-keyed rows whose route is not in the rate type routes[]'
SELECT 'seatrates' AS tbl, count(*) FROM sb_rate_types__seatrates s
  WHERE NOT EXISTS (SELECT 1 FROM sb_rate_types__routes r WHERE r.sb_rate_types_id = s.sb_rate_types_id AND r.value = s.key)
UNION ALL SELECT 'charterrates', count(*) FROM sb_rate_types__charterrates s
  WHERE NOT EXISTS (SELECT 1 FROM sb_rate_types__routes r WHERE r.sb_rate_types_id = s.sb_rate_types_id AND r.value = s.key)
UNION ALL SELECT 'routevalidity', count(*) FROM sb_rate_types__routevalidity s
  WHERE NOT EXISTS (SELECT 1 FROM sb_rate_types__routes r WHERE r.sb_rate_types_id = s.sb_rate_types_id AND r.value = s.key)
UNION ALL SELECT 'routebundles', count(*) FROM sb_rate_types__routebundles s
  WHERE NOT EXISTS (SELECT 1 FROM sb_rate_types__routes r WHERE r.sb_rate_types_id = s.sb_rate_types_id AND r.value = s.key);
\echo '== route validity: malformed / out of order'
SELECT count(*) AS rows,
       count(*) FILTER (WHERE coalesce("from", '') <> '' AND "from" !~ '^\d{4}-\d{2}-\d{2}$') AS bad_from,
       count(*) FILTER (WHERE coalesce("to", '') <> '' AND "to" !~ '^\d{4}-\d{2}-\d{2}$') AS bad_to,
       count(*) FILTER (WHERE coalesce("from", '') <> '' AND coalesce("to", '') <> '' AND "from" > "to") AS from_after_to
  FROM sb_rate_types__routevalidity;
\echo '== seat rates: rows, negatives, all-null zones, the stray kl text column'
SELECT count(*) AS rows,
  count(*) FILTER (WHERE least(pk_adult_thai, pk_adult_fr, pk_child_thai, pk_child_fr, pk_infant_thai, pk_infant_fr,
    kl_adult_thai, kl_adult_fr, kl_child_thai, kl_child_fr, kl_infant_thai, kl_infant_fr,
    notransfer_adult_thai, notransfer_adult_fr, notransfer_child_thai, notransfer_child_fr, notransfer_infant_thai, notransfer_infant_fr) < 0) AS negative,
  count(*) FILTER (WHERE num_nonnulls(pk_adult_thai, pk_adult_fr, pk_child_thai, pk_child_fr) = 0) AS pk_empty,
  count(*) FILTER (WHERE num_nonnulls(kl_adult_thai, kl_adult_fr, kl_child_thai, kl_child_fr) = 0) AS kl_empty,
  count(*) FILTER (WHERE num_nonnulls(notransfer_adult_thai, notransfer_adult_fr, notransfer_child_thai, notransfer_child_fr) = 0) AS nt_empty,
  count(*) FILTER (WHERE coalesce(kl, '') <> '') AS kl_text_set,
  count(*) FILTER (WHERE coalesce(pk_infant_thai, 0) + coalesce(pk_infant_fr, 0) + coalesce(kl_infant_thai, 0) + coalesce(kl_infant_fr, 0)
                         + coalesce(notransfer_infant_thai, 0) + coalesce(notransfer_infant_fr, 0) > 0) AS infant_priced
  FROM sb_rate_types__seatrates;
SELECT left(kl, 160) AS kl_text_sample FROM sb_rate_types__seatrates WHERE coalesce(kl, '') <> '' LIMIT 3;
\echo '== price tiers (json text)'
SELECT count(*) FILTER (WHERE coalesce(pricetiers, '') NOT IN ('', '{}', 'null')) AS with_tiers FROM sb_rate_types;
SELECT left(pricetiers, 200) AS tiers_sample FROM sb_rate_types WHERE coalesce(pricetiers, '') NOT IN ('', '{}', 'null') LIMIT 2;
\echo '== charter rates'
SELECT count(*) AS rows,
  count(*) FILTER (WHERE speedboat_starterprice IS NOT NULL) AS speedboat, count(*) FILTER (WHERE catamaran_starterprice IS NOT NULL) AS catamaran,
  count(*) FILTER (WHERE least(speedboat_starterprice, speedboat_extraperpax, catamaran_starterprice, catamaran_extraperpax) < 0) AS negative
  FROM sb_rate_types__charterrates;
\echo '== bundles'
SELECT coalesce(longtail_mode, '(null)') AS mode, count(*), count(*) FILTER (WHERE coalesce(longtail_adult, 0) + coalesce(longtail_child, 0) > 0) AS priced
  FROM sb_rate_types__routebundles GROUP BY 1;
\echo '== add-ons by key and unit'
SELECT key, coalesce(unit, '(null)') AS unit, count(*),
  count(*) FILTER (WHERE adult IS NOT NULL OR child IS NOT NULL) AS flat_adult_child,
  count(*) FILTER (WHERE join_adult IS NOT NULL OR charter_price IS NOT NULL) AS flat_join_charter
  FROM sb_rate_types__addons GROUP BY 1, 2 ORDER BY 1;
\echo '== longtail: byRoute rows, applies rows, longtail with neither'
SELECT (SELECT count(*) FROM sb_rate_types__addons__byroute) AS byroute_rows,
       (SELECT count(*) FROM sb_rate_types__addons__applies) AS applies_rows,
       (SELECT count(*) FROM sb_rate_types__addons a WHERE a.key = 'longtail'
          AND NOT EXISTS (SELECT 1 FROM sb_rate_types__addons__byroute b WHERE b.sb_rate_types_addons_id = a.row_pk)
          AND NOT EXISTS (SELECT 1 FROM sb_rate_types__addons__applies p WHERE p.sb_rate_types_addons_id = a.row_pk)) AS longtail_all_routes,
       (SELECT count(*) FROM sb_rate_types__addons__byroute b WHERE NOT EXISTS (SELECT 1 FROM sb_rate_types__addons a WHERE a.row_pk = b.sb_rate_types_addons_id)) AS orphan_byroute,
       (SELECT count(*) FROM sb_rate_types__addons__applies b WHERE NOT EXISTS (SELECT 1 FROM sb_rate_types__addons a WHERE a.row_pk = b.sb_rate_types_addons_id)) AS orphan_applies;
\echo '== longtail routes outside the rate type routes[]'
SELECT count(*) FROM sb_rate_types__addons__byroute b JOIN sb_rate_types__addons a ON a.row_pk = b.sb_rate_types_addons_id
  WHERE NOT EXISTS (SELECT 1 FROM sb_rate_types__routes r WHERE r.sb_rate_types_id = a.sb_rate_types_id AND r.value = b.key);
\echo '== private transfer rows per route table, zones, orphans'
SELECT 'r4' AS route, count(*), string_agg(DISTINCT key, ',') AS zones FROM sb_rate_types__addons__r4
UNION ALL SELECT 'r5', count(*), string_agg(DISTINCT key, ',') FROM sb_rate_types__addons__r5
UNION ALL SELECT 'r6', count(*), string_agg(DISTINCT key, ',') FROM sb_rate_types__addons__r6
UNION ALL SELECT 'r10', count(*), string_agg(DISTINCT key, ',') FROM sb_rate_types__addons__r10
UNION ALL SELECT 'r11', count(*), string_agg(DISTINCT key, ',') FROM sb_rate_types__addons__r11
UNION ALL SELECT 'r12', count(*), string_agg(DISTINCT key, ',') FROM sb_rate_types__addons__r12;
\echo '== agents bound to a rate type that does not exist; bindings table'
SELECT count(*) FILTER (WHERE coalesce(ratetypeid, '') <> '') AS bound,
       count(*) FILTER (WHERE coalesce(ratetypeid, '') <> '' AND ratetypeid NOT IN (SELECT id FROM sb_rate_types)) AS dangling
  FROM sb_agents;
SELECT count(*) AS binding_rows, count(*) FILTER (WHERE ratetypeid NOT IN (SELECT id FROM sb_rate_types)) AS dangling FROM sb_agents_rate_bindings;
\echo '== bookings: rate_type_ref values not a rate type id'
SELECT count(*) FILTER (WHERE coalesce(ratetyperef, '') <> '') AS with_ref,
       count(*) FILTER (WHERE coalesce(ratetyperef, '') <> '' AND ratetyperef NOT IN (SELECT id FROM sb_rate_types)) AS ref_not_an_id
  FROM sb_bookings;
\echo '== pier of covered routes (which zone set applies)'
SELECT coalesce(ro.pier, '(none)') AS pier, coalesce(ro.kind, '(null)') AS kind, count(*) FROM sb_rate_types__routes r LEFT JOIN routes ro ON ro.id = r.value GROUP BY 1, 2;
