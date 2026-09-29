// The @sig-net/midnight 0.23.0 exports the bridge code needs, reached by file path.
//
// ADAPTED from acedward/passport @ 6c7505a4d2ec223fce5eb10266c331576805465a (PR #4)
// `contract/contracts/erc20-vault/src/signet-sdk.ts`, the same way MN Bank adapts it
// (acedward/passport-evm-dapp @ 911647b, relay/src/bridge/vendor/signet-sdk.ts). Upstream re-exports
// the package's dist files by the relative path `../node_modules/@sig-net/midnight/dist/*.js`,
// because the package root cannot load on compact-runtime 0.19.0 (its generated module pins
// 0.18.0-rc.1) and its `exports` map hides dist/*. That path only resolves inside the vault
// package's own install; this shim does the same through THIS repository's hoisted root install
// (bunfig.toml), which pins the same 0.23.0 (bun.lock; the integrity equals the vault's
// package-lock.json). It exports only what relayer.ts (vendored beside it) and the deposit-address
// derivation use, and never `pureCircuits`.
//
// These dist modules import only @noble/curves, ethers, @sig-net/midnight-serde, compact-runtime's
// plain helpers and each other; none imports a generated contract module (upstream Q25).

export { serializeRespondOutput } from '../../../../node_modules/@sig-net/midnight/dist/abi-serde.js';
export { bytesToHex, hexToBytes } from '../../../../node_modules/@sig-net/midnight/dist/byte-codecs.js';
export {
  MPC_FAILURE_OUTPUT,
  getMpcOutputCacheUrl,
  getMpcRootPublicKey,
  getSignetContractAddress,
} from '../../../../node_modules/@sig-net/midnight/dist/constants.js';
export {
  deriveEvmAddress,
  deriveMidnightResponseKey,
} from '../../../../node_modules/@sig-net/midnight/dist/epsilon-derivation.js';
export { MpcOutputCacheReader } from '../../../../node_modules/@sig-net/midnight/dist/mpc-output-cache.js';
export { signetEventSourceFromIndexer } from '../../../../node_modules/@sig-net/midnight/dist/signet-contract-events.js';
export { SignetRequestResponseReader } from '../../../../node_modules/@sig-net/midnight/dist/signet-request-response-reader.js';
export {
  requestIdBytes,
  toSignBidirectionalEventIndex,
} from '../../../../node_modules/@sig-net/midnight/dist/signet-requests.js';
export {
  formatSecp256k1PublicKey,
  normaliseSecp256k1PublicKey,
  respondBidirectionalEventToCircuitInput,
  verifyRespondBidirectionalSignature,
} from '../../../../node_modules/@sig-net/midnight/dist/ecdsa-attestation.js';

/** The @sig-net/midnight version these paths were checked against. */
export const SIG_NET_MIDNIGHT_VERSION = '0.23.0';
