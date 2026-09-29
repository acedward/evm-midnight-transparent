// What the page says when this browser will not keep this app's records. One wording per cause,
// unit-tested. Adapted from MN Bank (acedward/passport-evm-dapp @ 911647b, web/src/store/messages.ts).

import { APP_NAME } from '../brand.js';
import type { StorageStatus } from './probe.js';

export function storageText(status: Exclude<StorageStatus, 'ok'>): { title: string; text: string } {
  switch (status) {
    case 'full':
      return {
        title: `This browser has no room left for ${APP_NAME}’s records.`,
        text: `${APP_NAME} keeps each swap's record in this browser so a swap can be resumed, so it will not start a swap here until there is room. Free some site data (for example other sites’ storage), then reload this page.`,
      };
    case 'unavailable':
      return {
        title: 'This browser has no local storage.',
        text: `${APP_NAME} keeps each swap's record in this browser so a swap can be resumed. Use a browser with local storage turned on.`,
      };
    case 'blocked':
      return {
        title: `This browser is not letting ${APP_NAME} keep data.`,
        text: `This happens in a private window, or when site data is blocked. ${APP_NAME} keeps each swap's record in this browser so a swap can be resumed: open it in a normal window, or allow site data for it.`,
      };
  }
}
