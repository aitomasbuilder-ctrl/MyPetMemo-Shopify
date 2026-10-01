'use strict';
const STATUSES = ['photo_uploaded', 'artwork_generating', 'waiting_approval', 'approved', 'paid', 'sent_to_printify', 'production_started', 'fulfilled', 'error'];
// Forward-only, except error which can be entered from anywhere and left only by a manual retry.
const ORDER = Object.fromEntries(STATUSES.map((s, i) => [s, i]));

function canTransition(from, to) {
  if (!(to in ORDER)) return false;
  if (to === 'error') return true;
  if (!from || from === 'error') return to === 'paid' || from === 'error';
  return ORDER[to] > ORDER[from];
}
module.exports = { STATUSES, canTransition };
