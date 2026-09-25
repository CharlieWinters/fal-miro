// Message names node.html uses. A copy of NODE_MSG in shared/node.ts, kept
// here because embed pages may not import outside src/embed. node.test.ts
// fails if the two drift apart.

export const PAGE_MSG = {
  hello: 'fal-node:hello',
  state: 'fal-node:state',
  open: 'fal-node:open',
  generate: 'fal-node:generate',
  opened: 'fal-node:opened',
  error: 'fal-node:error',
  changed: 'fal-node:changed',
} as const;

export const INSTALL_URL =
  'https://miro.com/app-install/?response_type=code&client_id=3458764674362323749&redirect_uri=%2Fapp-install%2Fconfirm%2F';
