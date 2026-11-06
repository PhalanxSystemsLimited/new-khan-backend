/** CNIC helpers. Input may have dashes ("35202-1234567-1") or not; stored on bookings as 13 digits. */
export const cnicDigits = (v) => String(v ?? '').replace(/\D/g, '');

/** 35202-1234567-1 */
export const cnicDisplay = (v) => {
  const d = cnicDigits(v);
  return `${d.slice(0, 5)}-${d.slice(5, 12)}-${d.slice(12)}`;
};

/** 35202-•••••••-1: enough for staff to recognise it, without putting the whole number on screen. */
export const cnicMasked = (v) => {
  const d = cnicDigits(v);
  return d.length === 13 ? `${d.slice(0, 5)}-•••••••-${d.slice(12)}` : null;
};
