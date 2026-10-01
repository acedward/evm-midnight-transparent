// The design system's typeface: Inter (variable), SELF-HOSTED from @fontsource-variable/inter (SIL Open
// Font License 1.1; the licence text ships with the site under licenses/). The @font-face rule is in
// ./fonts.css (the Latin subset only).
//
// Why not a font CDN: a request to fonts.googleapis.com hands every visitor's IP address to a third
// party before they have done anything (a German court found exactly that to breach the GDPR, LG
// München I, 3 O 17493/20, January 2022). The app tells users its servers keep nothing about them, so
// the page must not leak them to Google either. Self-hosting also keeps the site working under the
// strict CSP (font-src 'self'), offline, and in the browser tests, which refuse every request that
// leaves the page's own origin.
import './fonts.css';
