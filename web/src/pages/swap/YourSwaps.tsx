// "Your swaps": the connected wallet's swap records in this browser (Local data holds them; Export
// takes them to another browser), with Open, and Resume for one that is not finished and not running
// in this tab. A swap whose tokens all arrived at the user's address (verified on Sepolia) shows Done
// while the bridge closes the request in the background, as on its page (P4.2-fix4).

import {
  ButtonLink,
  Button,
  Cell,
  EmptyState,
  Panel,
  StatementTable,
  StatusPill,
  Sub,
  type PillStatus,
} from '../../design/index.js';
import { dateText, legText } from '../../swap/display.js';
import {
  type SwapRecord,
  isDoneForUser,
  isRecoverable,
  isRecoverableUnknown,
  isResumable,
} from '../../swap/record-shape.js';
import { useSwap } from '../../swap/SwapContext.js';

const PHASE_TEXT: Record<SwapRecord['phase'], string> = {
  funding: 'Waiting for your funds',
  'bridging-in': 'Bridging in',
  taking: 'Taking the offer',
  unavailable: 'Swap is not available',
  'bridging-out': 'Bridging out',
  'bridging-back': 'Bridging back',
  done: 'Done',
  failed: 'Failed',
};

function pill(r: SwapRecord): PillStatus {
  if (isDoneForUser(r))
    return (r.outcome ?? (r.choice === 'bridge-back' ? 'bridged-back' : 'swapped')) === 'bridged-back'
      ? 'refunded'
      : 'done';
  if (r.phase === 'failed') return 'failed';
  return 'progress';
}

export function YourSwaps() {
  const { records, session, resume, startBlocker } = useSwap();
  if (records.length === 0) return null;
  return (
    <Panel title="Your swaps" data-testid="your-swaps" className="section-gap">
      <StatementTable
        caption="Your swaps in this browser"
        columns={[
          { label: 'Swap' },
          { label: 'State' },
          { label: 'Started', sub: 'UTC', align: 'right' },
          { label: 'Action', srOnly: true, align: 'right' },
        ]}
      >
        {records.map((r) => {
          const s = session(r.swapId);
          const running = !!s && !s.isClosed && !s.isStuck;
          // P4.2-fix4: every token arrived (verified); the sponsor has not closed the request yet.
          const closing = isDoneForUser(r) && r.phase !== 'done';
          const text = closing
            ? r.choice === 'bridge-back'
              ? 'Bridged back'
              : 'Done'
            : r.outcome === 'bridged-back'
              ? r.partial
                ? 'Bridged back what arrived'
                : 'Bridged back'
              : r.partial && r.choice === 'swap' && r.phase === 'bridging-in'
                ? // P4.2-fix3 S2: part of the deposit arrived; the swap page asks what to do.
                  r.partial.wait
                  ? 'Part arrived: waiting for the rest'
                  : 'Part of the deposit arrived: choose'
                : isRecoverable(r)
                  ? 'Failed: can be resumed'
                  : isRecoverableUnknown(r)
                    ? 'Failed: resume to ask the sponsor'
                    : PHASE_TEXT[r.phase];
          return (
            <tr
              key={r.swapId}
              data-testid="swap-record"
              data-swap-id={r.swapId}
              data-phase={r.phase}
              data-done={isDoneForUser(r) ? (closing ? 'closing' : 'closed') : 'no'}
            >
              <Cell block>
                <strong>
                  {legText(r.offer.pay)} → {legText(r.offer.receive)}
                </strong>
                <Sub multiline>
                  {r.deterministic ? 'recoverable by signing again' : 'not recoverable after its tab closes'}
                </Sub>
              </Cell>
              <Cell label="State">
                <span>
                  <StatusPill status={pill(r)}>{text}</StatusPill>
                  {closing && <Sub multiline>the bridge closes the request in the background</Sub>}
                  {running && !closing && <Sub>running in this tab</Sub>}
                </span>
              </Cell>
              <Cell label="Started" align="right" num>
                {dateText(r.createdAt)}
              </Cell>
              <Cell label="" align="right">
                {isResumable(r) && !running ? (
                  <Button
                    size="small"
                    data-testid="record-resume"
                    disabled={startBlocker !== null}
                    onClick={() => {
                      resume(r);
                      window.location.hash = `#swap?id=${r.swapId}`;
                    }}
                  >
                    Resume
                  </Button>
                ) : (
                  <ButtonLink size="small" href={`#swap?id=${r.swapId}`} data-testid="record-open">
                    Open
                  </ButtonLink>
                )}
              </Cell>
            </tr>
          );
        })}
      </StatementTable>
      <p className="table-note">
        These records hold no key. Each holds its swap&apos;s salt, which Resume needs: keep an export private, and only
        sign a swap&apos;s start message in this app. To continue a swap in another browser, export them under{' '}
        <a href="#local">Local data</a>.
      </p>
    </Panel>
  );
}

export function NoWalletYet() {
  return (
    <EmptyState title="Connect your wallet to swap" data-testid="connect-first">
      The offers below are live. Connect an EVM wallet on Sepolia to take one.
    </EmptyState>
  );
}
