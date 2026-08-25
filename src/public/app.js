const health = document.querySelector('#health');

fetch('/api/health')
  .then((response) => response.json())
  .then(({ status }) => {
    health.textContent = `Service status: ${status}`;
  })
  .catch(() => {
    health.textContent = 'Service status: unavailable';
  });
