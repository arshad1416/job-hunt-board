export function stepLog(step, data = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), step, ...data }));
}
