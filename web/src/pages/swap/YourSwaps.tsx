// "Your swaps": the connected wallet's swap records in this browser (Local data holds them; Export
// takes them to another browser), with Open, and Resume for one that is not finished and not running
// in this tab.

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
import { type SwapRecord, isFinished } from '../../swap/record-shape.js';
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
  if (r.phase === 'done') return r.outcome === 'bridged-back' ? 'refunded' : 'done';
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
          const running = !!s && !s.isClosed;
          const text = r.outcome === 'bridged-back' ? 'Bridged back' : PHASE_TEXT[r.phase];
          return (
            <tr key={r.swapId} data-testid="swap-record" data-swap-id={r.swapId} data-phase={r.phase}>
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
                  {running && <Sub>running in this tab</Sub>}
                </span>
              </Cell>
              <Cell label="Started" align="right" num>
                {dateText(r.createdAt)}
              </Cell>
              <Cell label="" align="right">
                {!isFinished(r) && !running ? (
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
        These records hold no key. To continue a swap in another browser, export them under{' '}
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
