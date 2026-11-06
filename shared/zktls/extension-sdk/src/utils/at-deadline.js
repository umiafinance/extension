// setTimeout caps one delay at about 24.8 days, so a later deadline re-arms.
const MAX_TIMEOUT_MS = 0x7fffffff;

/** Run `fn` once `deadline` (epoch ms) has passed, never synchronously; returns a cancel. */
export function atDeadline(deadline, fn) {
  let timer;
  const wait = () => {
    const delay = Math.max(0, Math.min(deadline - Date.now(), MAX_TIMEOUT_MS));
    timer = setTimeout(() => (Date.now() < deadline ? wait() : fn()), delay);
  };
  wait();
  return () => clearTimeout(timer);
}
