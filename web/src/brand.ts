// The app's name and tagline: the ONE place the page takes its name from (the masthead, messages,
// and index.html's title through the Vite config). "EVM Midnight Swap" is the working name (questions
// Q10, open). The EIP-712 domain names are separate constants in core (swap-key.ts, auth.ts): they are
// part of every signature, so renaming the page does not rename them.

export const APP_NAME = 'EVM Midnight Swap';
export const APP_TAGLINE = 'Swap on Midnight from your EVM wallet';
/** The two letters in the masthead's monogram. */
export const APP_MONOGRAM = 'EM';
