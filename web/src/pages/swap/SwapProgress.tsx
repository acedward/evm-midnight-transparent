// One swap's page: six stages with every hash as it lands (spec US1), "Swap is not available" with
// Bridge back (Q6), the determinism warning (Q4), refund retries (Q9 A), Resume for a swap that is
// not running in this tab (US2.2), a PARTIAL deposit (P4.2-fix3 S2): what arrived, what is missing,
// "Wait for the rest" or "Bridge back" what arrived; and Done on arrival (P4.2-fix4): Done as soon as
// every token is at the user's address, verified on Sepolia, with a quiet note while the bridge
// closes the request in the background, and the bridge's report shown if it contradicts that; and a
// quiet note while the sponsor is not answering, which the swap waits out (P4.5), never a stop.

import type { NetworkProfile } from '@evm-midnight-transparent/core';
import { useEffect, useState, type ReactNode } from 'react';

import { APP_NAME } from '../../brand.js';
import {
  Badge,
  Button,
  ButtonRow,
  Dialog,
  EmptyState,
  Hash,
  Notice,
  PageHead,
  Panel,
  StageTracker,
  type TrackerStage,
} from '../../design/index.js';
import { BRIDGE_CLOSE_ESTIMATE_MIN } from '../../swap/arrival.js';
import { amountText, clockText, elapsedText, ethText, legText } from '../../swap/display.js';
import { type StageKey, bridgeInStartedAt, stageStates, stageTitle } from '../../swap/flow.js';
import { bridgeRequestUrl, midnightTxUrl, sepoliaAddressUrl, sepoliaTxUrl } from '../../swap/links.js';
import { BRIDGE_IN_ESTIMATE_MIN } from '../../swap/offers.js';
import { partialOf } from '../../swap/partial.js';
import {
  type SwapRecord,
  arrivedAmount,
  arrivedInFull,
  isDoneForUser,
  isFinished,
  isResumable,
  outLeg as paidOutLeg,
} from '../../swap/record-shape.js';
import type { SessionSnapshot, SessionStatus, SwapSession } from '../../swap/session.js';
import { useSession, useSwap } from '../../swap/SwapContext.js';
import { LostNotice } from './LostNotice.js';

type TxKind = 'sepolia' | 'midnight' | 'request';

function TxLine({
  label,
  hash,
  kind,
  network,
  name,
}: {
  label: ReactNode;
  hash?: string;
  kind: TxKind;
  network: NetworkProfile;
  name: string;
}) {
  if (!hash) return null;
  const href =
    kind === 'sepolia'
      ? sepoliaTxUrl(network, hash)
      : kind === 'request'
        ? bridgeRequestUrl(network, hash)
        : midnightTxUrl(network, hash);
  return (
    <li className="tx-line" data-testid="tx-line" data-kind={kind} data-name={name}>
      <span className="tx-label">{label}</span> <Hash value={hash} head={8} tail={6} {...(href ? { href } : {})} />
    </li>
  );
}

function SubStages({
  stages,
  testId,
  leg,
}: {
  stages?: SwapRecord['bridgeIn']['stages'];
  testId: string;
  leg: 'deposit' | 'withdraw';
}) {
  if (!stages || stages.length === 0) return null;
  return (
    <ol className="substages" data-testid={testId}>
      {stages.map((s, i) => (
        <li key={`${s.stage}-${i}`} data-stage={s.stage}>
          <span>{stageTitle(leg, s.stage)}</span> <span className="num muted">{clockText(s.at)}</span>
        </li>
      ))}
    </ol>
  );
}

function useNow(ms: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

const PROMPT: Record<Extract<SessionStatus, { kind: 'signing' }>['prompt'], string> = {
  'start-1': 'Sign “Start or resume a swap” in your wallet (signature 1 of 3).',
  'start-2':
    'Sign the same “Start or resume a swap” message again (2 of 3): this checks that your wallet signs it the same way every time.',
  sponsor: 'Sign the sponsor authorisation (the last signature): it lets the sponsor pay this swap’s Midnight fees.',
  resume: 'Sign “Start or resume a swap” again: it re-creates this swap’s temporary Midnight wallet.',
};

/** Shown with every “Start or resume a swap” prompt (P4.2-fix C14): EIP-712 cannot bind the site. */
const SIGN_HERE_ONLY =
  'Only sign it here, in this app: the signature is the key to the swap’s tokens, and whoever gets it can take them. Never sign it on another site.';

/** "Bridged back." or "Done.": the sponsor's outcome, or before it says `done` the user's choice. */
const doneText = (record: SwapRecord | null) =>
  (record?.outcome ?? (record?.choice === 'bridge-back' ? 'bridged-back' : 'swapped')) === 'bridged-back'
    ? 'Bridged back.'
    : 'Done.';

function statusLine(snap: SessionSnapshot | null, record: SwapRecord | null): string {
  if (!snap)
    return record && isFinished(record)
      ? 'Finished.'
      : record && isDoneForUser(record)
        ? doneText(record)
        : 'Not running in this tab.';
  const s = snap.status;
  switch (s.kind) {
    case 'signing':
      return PROMPT[s.prompt];
    case 'confirm-nondeterministic':
      return 'Your wallet signed differently the second time: decide whether to continue.';
    case 'opening':
      return 'Opening the swap with the sponsor…';
    case 'fund':
      // S2: on a partial deposit only the sweep gas is ever asked for (never the token again).
      if (record?.partial && !s.sending) return 'Top up the sweep gas: the bridge needs it to bring in the rest.';
      return s.sending === 'confirming'
        ? 'Waiting for the sweep gas transfer to be confirmed on Sepolia before the token transfer.'
        : s.sending
          ? 'Confirm the transfers in your wallet.'
          : 'Send the funds to start the bridge.';
    case 'working':
      return `${s.what}…`;
    case 'unavailable':
      return 'Swap is not available.';
    case 'partial':
      return 'Only part of your deposit reached the temporary wallet: choose below.';
    case 'done':
      return s.conflict ? `${doneText(record)} The bridge reports something else: see below.` : doneText(record);
    case 'error':
      return 'Stopped by an error.';
    case 'stopped':
      return s.message;
  }
}

function NonDeterministicDialog({ session, open }: { session: SwapSession; open: boolean }) {
  return (
    <Dialog
      open={open}
      tone="danger"
      testId="nondet-dialog"
      title="Your wallet signed the message differently the second time"
      onClose={() => session.confirmNonDeterministic(false)}
      actions={
        <>
          <Button
            variant="secondary"
            data-testid="nondet-cancel"
            onClick={() => session.confirmNonDeterministic(false)}
          >
            Cancel the swap
          </Button>
          <Button variant="danger" data-testid="nondet-continue" onClick={() => session.confirmNonDeterministic(true)}>
            I understand, continue
          </Button>
        </>
      }
    >
      <p>
        This swap&apos;s temporary Midnight wallet is made from your signature. Your wallet gave two different
        signatures for the same message, so signing again later would make a different wallet.
      </p>
      <Notice tone="danger" className="dialog-notice">
        <strong>This swap cannot be recovered after this tab closes.</strong> If you continue, keep this tab open until
        the swap is done: if it closes before, the tokens in the swap are lost. Nothing has been sent yet.
      </Notice>
    </Dialog>
  );
}

function AllHashes({ record, network }: { record: SwapRecord; network: NetworkProfile }) {
  const r = record;
  const lines: Array<[string, string, string | undefined, TxKind]> = [
    ['fund-eth', 'Sweep gas sent (Sepolia)', r.funding.eth?.hash, 'sepolia'],
    ['fund-token', `${r.offer.pay.symbol} sent (Sepolia)`, r.funding.token?.hash, 'sepolia'],
    ['bridge-in-request', 'Bridge-in request', r.bridgeIn.requestId, 'request'],
    ['bridge-in-start', 'Deposit started (Midnight)', r.bridgeIn.startTx, 'midnight'],
    ['bridge-in-sweep', 'Sweep into the vault (Sepolia)', r.bridgeIn.sweepTx, 'sepolia'],
    ['bridge-in-complete', 'Minted to the temporary wallet (Midnight)', r.bridgeIn.completeTx, 'midnight'],
    ['take', 'Offer taken (Midnight)', r.take.tx, 'midnight'],
    ...(r.bridgeOut.earlier ?? []).flatMap((e, i): Array<[string, string, string | undefined, TxKind]> => [
      [`refunded-${i}-request`, `Refunded withdrawal ${i + 1}: request`, e.requestId, 'request'],
      [`refunded-${i}-start`, `Refunded withdrawal ${i + 1}: started (Midnight)`, e.startTx, 'midnight'],
      [`refunded-${i}-complete`, `Refunded withdrawal ${i + 1}: refunded (Midnight)`, e.completeTx, 'midnight'],
    ]),
    [
      'bridge-out-request',
      r.choice === 'bridge-back' ? 'Bridge-back request' : 'Bridge-out request',
      r.bridgeOut.requestId,
      'request',
    ],
    ['bridge-out-start', 'Withdrawal started (Midnight)', r.bridgeOut.startTx, 'midnight'],
    ['bridge-out-sepolia', 'Tokens sent to you (Sepolia)', r.bridgeOut.sepoliaTx, 'sepolia'],
    ['bridge-out-complete', 'Withdrawal closed (Midnight)', r.bridgeOut.completeTx, 'midnight'],
  ];
  const present = lines.filter(([, , h]) => h);
  if (present.length === 0) return null;
  return (
    <Panel
      title="Transactions"
      data-testid="all-hashes"
      meta={
        <span className="small muted">
          {present.length} {isFinished(record) ? 'in all' : 'so far'}
        </span>
      }
    >
      <ul className="tx-list">
        {present.map(([name, label, hash, kind]) => (
          <TxLine key={name} name={name} label={label} hash={hash} kind={kind} network={network} />
        ))}
      </ul>
      {!network.midnight.explorerUrl && (
        <p className="table-note">
          Midnight hashes are shown to copy: no Midnight explorer is configured for {network.name}.
        </p>
      )}
    </Panel>
  );
}

export function SwapProgress({ swapId }: { swapId: string }) {
  const ctx = useSwap();
  const network = ctx.config.network;
  const session = ctx.session(swapId);
  const snap = useSession(session);
  const stored = ctx.records.find((r) => r.swapId === swapId.toLowerCase()) ?? null;
  const record = snap?.record ?? stored;
  const now = useNow(1_000);

  if (!snap && !record)
    return (
      <EmptyState title="This swap is not in this browser" data-testid="swap-missing">
        Connect the wallet that started it. To continue a swap started in another browser, import that browser&apos;s
        export under <a href="#local">Local data</a>.
      </EmptyState>
    );

  // A session stopped for good (a failed swap the sponsor can revive) is not running: Resume replaces it.
  const running = !!session && !session.isClosed && !session.isStuck;
  const status = snap?.status ?? null;
  const offer = record?.offer ?? null;
  const pay = offer?.pay ?? (snap?.offer ? { ...legOf(snap.offer.pay) } : null);
  const receive = offer?.receive ?? (snap?.offer ? { ...legOf(snap.offer.receive) } : null);
  const states = stageStates(record);
  const finished = !!record && isFinished(record);
  const resumable = !!record && isResumable(record);
  // P4.2-fix4: every token is at the user's address (verified on Sepolia); `closing` while the bridge
  // has not closed the request yet (the sponsor's `done`).
  const doneForUser = !!record && isDoneForUser(record);
  const closing = doneForUser && record?.phase !== 'done';
  const conflict = status?.kind === 'done' ? (status.conflict ?? null) : null;
  const unavailable = record?.phase === 'unavailable';
  const back = record?.choice === 'bridge-back';
  // P4.2-fix3 S2: part of the pay amount is in the temporary wallet, the rest at the deposit address.
  const partial = record?.partial ?? null;
  const partialOpen = !!partial && !back && !finished;
  // The sponsor's live report (its options, the deposit address's balance, a paced start).
  const live = record && snap?.view ? partialOf(snap.view, BigInt(record.offer.pay.amount)) : null;

  const startDetail = (
    <>
      {status?.kind === 'signing' && <p data-testid="sign-prompt">{PROMPT[status.prompt]}</p>}
      {status?.kind === 'signing' && status.prompt !== 'sponsor' && (
        <Notice tone="warning" data-testid="sign-here-only">
          {SIGN_HERE_ONLY}
        </Notice>
      )}
      {status?.kind === 'opening' && <p>Opening the swap with the sponsor…</p>}
      {(record?.temp ?? snap?.temp) && (
        <ul className="tx-list">
          <li className="tx-line">
            <span className="tx-label">Temporary Midnight wallet</span>{' '}
            <Hash value={(record?.temp ?? snap!.temp)!.shieldedAddress} head={16} tail={6} data-testid="temp-address" />
          </li>
          <li className="tx-line">
            <span className="tx-label">Swap id</span> <Hash value={swapId} head={8} tail={6} />
          </li>
        </ul>
      )}
      {(record?.deterministic ?? snap?.deterministic) === true && (
        <Badge tone="green" data-testid="recoverable">
          Recoverable by signing again
        </Badge>
      )}
      {(record?.deterministic ?? snap?.deterministic) === false && (
        <Badge tone="red" data-testid="not-recoverable">
          Not recoverable after this tab closes
        </Badge>
      )}
    </>
  );

  const fundStatus = status?.kind === 'fund' ? status.sending : null;
  // P4.2-fix C9: no funding while the wallet is off Sepolia (or on another account).
  const fundingPaused = snap?.fundingBlocked ?? null;
  const fundDetail = record && (
    <>
      <p>
        Two transactions from your wallet to the swap&apos;s deposit address{' '}
        <Hash
          value={record.deposit.address}
          head={8}
          tail={6}
          href={sepoliaAddressUrl(network, record.deposit.address)}
          data-testid="deposit-address"
        />
        :
      </p>
      <ul className="tx-list">
        <li className="tx-line" data-testid="funding-eth">
          <span className="tx-label">
            1. Sweep gas: <strong className="num">{ethText(record.deposit.sweepGas.ethWei)}</strong>
            <span className="sub multiline">
              Pays the bridge&apos;s Sepolia transaction that moves your tokens into the vault (
              {BigInt(record.deposit.sweepGas.gasLimit).toLocaleString('en-US')} gas at most); what it does not use
              stays at the deposit address.
            </span>
          </span>{' '}
          {record.funding.eth && (
            <>
              <Hash
                value={record.funding.eth.hash}
                head={8}
                tail={6}
                href={sepoliaTxUrl(network, record.funding.eth.hash)}
              />{' '}
              <Badge tone={record.funding.eth.status === 'failed' ? 'red' : 'grey'}>{record.funding.eth.status}</Badge>
            </>
          )}
        </li>
        <li className="tx-line" data-testid="funding-token">
          <span className="tx-label">
            2. Exactly <strong className="num">{legText(record.offer.pay)}</strong>
            <span className="sub multiline">
              The amount the offer wants: never more, since any excess at the deposit address is lost.
            </span>
          </span>{' '}
          {record.funding.token && (
            <>
              <Hash
                value={record.funding.token.hash}
                head={8}
                tail={6}
                href={sepoliaTxUrl(network, record.funding.token.hash)}
              />{' '}
              <Badge tone={record.funding.token.status === 'failed' ? 'red' : 'grey'}>
                {record.funding.token.status}
              </Badge>
            </>
          )}
        </li>
      </ul>
      {status?.kind === 'fund' && fundingPaused && (
        <p className="small" data-testid="funding-paused">
          {fundingPaused}
        </p>
      )}
      {status?.kind === 'fund' && !partial && (
        <ButtonRow stretch>
          <Button
            data-testid="send-funds"
            disabled={fundStatus !== null || fundingPaused !== null}
            onClick={() => void session?.sendFunds()}
          >
            {fundStatus === 'eth'
              ? 'Confirm the sweep gas in your wallet…'
              : fundStatus === 'confirming'
                ? 'Waiting for the sweep gas to be confirmed…'
                : fundStatus === 'token'
                  ? `Confirm the ${record.offer.pay.symbol} transfer in your wallet…`
                  : fundStatus === 'checking'
                    ? 'Checking…'
                    : 'Send funds'}
          </Button>
        </ButtonRow>
      )}
    </>
  );

  const inStart = record ? bridgeInStartedAt(record) : undefined;
  const payPart = (amount: string) => (record ? legText({ ...record.offer.pay, amount }) : '');
  const topUp = status?.kind === 'fund' && (
    <ButtonRow className="gap-top">
      <Button
        data-testid="partial-top-up"
        disabled={fundStatus !== null || fundingPaused !== null}
        onClick={() => void session?.sendFunds()}
      >
        {fundStatus === 'eth' ? 'Confirm the sweep gas in your wallet…' : 'Top up the sweep gas'}
      </Button>
    </ButtonRow>
  );
  const partialDetail = record && partial && partialOpen && (
    <Notice
      tone="warning"
      title="Only part of your deposit arrived."
      data-testid="partial-deposit"
      data-wait={partial.wait ? 'yes' : 'no'}
      className="gap-top"
    >
      Another bridge request for this swap swept part of the deposit address before the sponsor&apos;s own (anyone can
      start one), so the bridge minted only that part. Your tokens are safe, and nothing is sent from your wallet unless
      you press a button here.
      <ul className="tx-list gap-top">
        <li className="tx-line" data-testid="partial-arrived">
          <span className="tx-label">In the temporary Midnight wallet</span>{' '}
          <strong className="num">{payPart(partial.minted)}</strong>
        </li>
        <li className="tx-line" data-testid="partial-missing">
          <span className="tx-label">Still to bridge in from the deposit address</span>{' '}
          <strong className="num">{payPart(partial.remaining)}</strong>
          {live?.atAddress !== null && live?.atAddress !== undefined && (
            <span className="sub multiline" data-testid="partial-at-address">
              The deposit address held {payPart(live.atAddress.toString())} when the sponsor last looked.
            </span>
          )}
        </li>
      </ul>
      {partial.wait ? (
        <p className="gap-top" data-testid="partial-waiting">
          <strong>Waiting for the rest.</strong> The sponsor bridges the remaining {payPart(partial.remaining)} in from
          the deposit address by itself (about {BRIDGE_IN_ESTIMATE_MIN} minutes once it starts
          {live?.retryAt ? `; it starts from ${clockText(live.retryAt)}` : ''}), then the swap goes on. Your{' '}
          {record.offer.pay.symbol} is not sent again.
        </p>
      ) : (
        live?.canWait !== false && (
          <p className="gap-top">
            <strong>Wait for the rest</strong>: the sponsor bridges the remaining {payPart(partial.remaining)} in from
            the deposit address by itself, then the swap goes on. Your {record.offer.pay.symbol} is not sent again; if
            the deposit address lacks sweep gas, you are asked to top up the ETH only.
          </p>
        )
      )}
      <p className="small">
        <strong>Bridge back</strong> returns the {payPart(partial.minted)} in the temporary wallet to your address on
        Sepolia now. The swap does not happen: the remaining {payPart(partial.remaining)} at the deposit address is then
        bridged into the temporary wallet (you may be asked to top up the sweep gas) and back to you too. This page
        never sends your {record.offer.pay.symbol} again.
      </p>
      {topUp}
      {running && snap?.view && !live ? (
        <p className="gap-top" data-testid="partial-rest-running">
          The sponsor is bridging in the rest from the deposit address.
        </p>
      ) : (
        <ButtonRow className="gap-top">
          {!partial.wait && live?.canWait !== false && (
            <Button
              data-testid="partial-wait"
              disabled={status?.kind !== 'partial' || !live?.canWait}
              onClick={() => session?.waitForRest()}
            >
              Wait for the rest
            </Button>
          )}
          <Button
            data-testid="partial-bridge-back"
            disabled={!session?.partialChoiceOpen}
            onClick={() => session?.bridgeBack()}
          >
            Bridge back {payPart(partial.minted)}
          </Button>
        </ButtonRow>
      )}
      {!running && <p className="small">Resume the swap first (above).</p>}
    </Notice>
  );
  // S2 after "Bridge back": what came back, and the rest on its way in to be bridged back too.
  const partialBackDetail = record && partial && back && !finished && !doneForUser && (
    <Notice tone="info" className="gap-top" data-testid="partial-back">
      Only part of your deposit arrived, and you chose to bridge it back.{' '}
      {partial.minted === '0' ? (
        <>
          The part that arrived is on its way back. The remaining {payPart(partial.remaining)} at the deposit address is
          bridged into the temporary wallet first, then back to you. Your {record.offer.pay.symbol} is not sent again.
        </>
      ) : (
        <>{payPart(partial.minted)} is being bridged back from the temporary wallet.</>
      )}
      {topUp}
    </Notice>
  );
  const bridgeInDetail = record && (
    <>
      <p className="small">
        About {BRIDGE_IN_ESTIMATE_MIN} minutes: the bridge waits for Sepolia finality and the MPC network&apos;s
        attestation, then mints {record.offer.pay.midnightName} to the temporary wallet.
        {inStart && !record.bridgeIn.completeTx ? (
          <>
            {' '}
            <span className="num" data-testid="bridge-in-elapsed">
              {elapsedText(now - inStart)} so far
            </span>
            .
          </>
        ) : null}
      </p>
      {partialDetail}
      <SubStages stages={record.bridgeIn.stages} testId="bridge-in-stages" leg="deposit" />
      <ul className="tx-list">
        <TxLine name="request" label="Request" hash={record.bridgeIn.requestId} kind="request" network={network} />
        <TxLine name="start" label="Deposit started" hash={record.bridgeIn.startTx} kind="midnight" network={network} />
        <TxLine name="sweep" label="Sweep on Sepolia" hash={record.bridgeIn.sweepTx} kind="sepolia" network={network} />
        <TxLine name="complete" label="Minted" hash={record.bridgeIn.completeTx} kind="midnight" network={network} />
      </ul>
    </>
  );

  const takeDetail = record && (
    <>
      {unavailable && (
        <Notice tone="danger" title="Swap is not available." data-testid="not-available">
          The offer was taken by someone else, or withdrawn, while your tokens were bridging in, so this swap cannot
          complete. Your {amountText(record.offer.pay.amount, record.offer.pay.decimals)}{' '}
          {record.offer.pay.midnightName} is safe in the swap&apos;s temporary Midnight wallet. Bridge it back to your
          address on Sepolia:
          <ButtonRow className="gap-top">
            <Button
              data-testid="bridge-back"
              disabled={status?.kind !== 'unavailable'}
              onClick={() => session?.bridgeBack()}
            >
              Bridge back {legText(record.offer.pay)}
            </Button>
          </ButtonRow>
          {!running && <p className="small">Resume the swap first (above).</p>}
        </Notice>
      )}
      {back && !unavailable && (
        <p>
          {partial
            ? 'Only part of your deposit arrived; you chose to bridge back what arrived.'
            : 'The offer was not available; you chose to bridge your tokens back.'}
        </p>
      )}
      {status?.kind === 'working' && record.phase === 'taking' && <p>{status.what}…</p>}
      {!unavailable && !back && <p className="small">Taken through the exchange, which pays the fee.</p>}
      <ul className="tx-list">
        <TxLine name="take" label="Taken" hash={record.take.tx} kind="midnight" network={network} />
      </ul>
    </>
  );

  // A Bridge back of a partial deposit returns what arrived, in parts (S2).
  const outLeg = record
    ? back
      ? partial && partial.minted !== '0' && !finished
        ? { ...record.offer.pay, amount: partial.minted }
        : record.offer.pay
      : record.offer.receive
    : null;
  const arrivedNow = record ? arrivedAmount(record) : 0n;
  const bridgeOutDetail = record && outLeg && (
    <>
      {partialBackDetail}
      <p className="small">
        {legText(outLeg)} to your address: it arrives about a minute after the withdrawal starts; the bridge closes the
        request about 17 minutes later.
      </p>
      {arrivedNow > 0n ? (
        // P4.2-fix4: read from the transfers' receipts (./arrival.ts), never from the sponsor's word.
        <p data-testid="arrived" data-full={arrivedInFull(record) ? 'yes' : 'no'}>
          <strong>
            {arrivedInFull(record)
              ? `${legText(paidOutLeg(record))} ${back ? 'came back' : 'arrived'} on Sepolia.`
              : `${amountText(arrivedNow, paidOutLeg(record).decimals)} of ${legText(paidOutLeg(record))} ${back ? 'came back' : 'arrived'} on Sepolia so far.`}
          </strong>{' '}
          <span className="small muted">Checked from the transfer&apos;s receipt on Sepolia.</span>
        </p>
      ) : (
        record.phase === 'done' &&
        record.bridgeOut.sepoliaTx &&
        !(back && partial) && (
          <p data-testid="arrived">
            <strong>
              {legText(outLeg)} {back ? 'came back' : 'arrived'} on Sepolia.
            </strong>
          </p>
        )
      )}
      <SubStages stages={record.bridgeOut.stages} testId="bridge-out-stages" leg="withdraw" />
      <ul className="tx-list">
        <TxLine name="request" label="Request" hash={record.bridgeOut.requestId} kind="request" network={network} />
        <TxLine
          name="start"
          label="Withdrawal started"
          hash={record.bridgeOut.startTx}
          kind="midnight"
          network={network}
        />
        <TxLine name="sepolia" label="Sent to you" hash={record.bridgeOut.sepoliaTx} kind="sepolia" network={network} />
        <TxLine name="complete" label="Closed" hash={record.bridgeOut.completeTx} kind="midnight" network={network} />
      </ul>
      {(record.bridgeOut.refunds ?? 0) > 0 && (
        <p className="small muted" data-testid="refunds">
          {record.bridgeOut.refunds} earlier {record.bridgeOut.refunds === 1 ? 'withdrawal was' : 'withdrawals were'}{' '}
          refunded or could not start, and the page built it again (your tokens stayed in the temporary wallet).
        </p>
      )}
    </>
  );

  const doneDetail = record && doneForUser && (
    <>
      <p data-testid="done-summary">
        {(record.outcome ?? (back ? 'bridged-back' : 'swapped')) === 'bridged-back'
          ? partial && partial.remaining !== '0' && !arrivedInFull(record)
            ? `The swap did not happen: ${payPart(partial.minted)} came back to your address. The other ${payPart(partial.remaining)} did not reach the temporary wallet: the sponsor found none of it at the deposit address ${record.deposit.address}.`
            : `The swap did not happen: ${legText(record.offer.pay)} came back to your address${partial ? ', in parts' : ''}.`
          : `You paid ${legText(record.offer.pay)} and received ${legText(record.offer.receive)}.`}{' '}
        The temporary wallet is empty.
      </p>
      {closing && !conflict && (
        <p className="small muted" data-testid="closing-note">
          The bridge closes the request on Midnight in the background (about {BRIDGE_CLOSE_ESTIMATE_MIN} minutes); there
          is nothing for you to do.
        </p>
      )}
    </>
  );

  const titles: Record<StageKey, string> = {
    start: 'Start swap',
    fund: 'Send funds',
    'bridge-in': `Bridge in${pay ? ` ${pay.midnightName}` : ''}`,
    take:
      back && partial
        ? 'Not taken: part of the deposit arrived'
        : unavailable || back
          ? 'Swap is not available'
          : 'Take the offer',
    'bridge-out': back || unavailable ? 'Bridge back' : `Bridge out${receive ? ` ${receive.midnightName}` : ''}`,
    done: 'Done',
  };
  const details: Record<StageKey, ReactNode> = {
    start: startDetail,
    fund: fundDetail,
    'bridge-in': bridgeInDetail,
    take: takeDetail,
    'bridge-out': bridgeOutDetail,
    done: doneDetail,
  };
  const stages: TrackerStage[] = (Object.keys(titles) as StageKey[]).map((k) => ({
    key: k,
    title: titles[k],
    state: states[k],
    detail: states[k] === 'pending' ? undefined : details[k],
    data: { testid: 'swap-stage', stage: k, state: states[k] },
  }));

  const title = pay && receive ? `Pay ${legText(pay)}, receive ${legText(receive)}` : 'Swap';
  return (
    <section
      data-testid="swap-page"
      data-phase={record?.phase ?? 'starting'}
      data-status={status?.kind ?? 'idle'}
      data-done={doneForUser ? (closing ? 'closing' : 'closed') : 'no'}
      aria-labelledby="swap-title"
    >
      <PageHead
        eyebrow="Swap"
        title={title}
        titleId="swap-title"
        lede={statusLine(snap, record)}
        actions={<a href="#swap">All offers</a>}
      />

      {!running && record && resumable && (
        <Notice
          tone="warning"
          title={
            !finished
              ? 'This swap is not running in this tab.'
              : record.recoverable === true
                ? 'This swap failed, and the sponsor can revive it.'
                : 'This swap failed. Resume it to ask the sponsor whether it can revive it.'
          }
          className="panel-intro"
          data-testid="resume-here"
        >
          Resume it: your wallet signs the swap&apos;s “Start or resume a swap” message once (it re-creates the
          swap&apos;s Midnight wallet; only ever sign it in this app), then the sponsor authorisation once.
          <ButtonRow className="gap-top">
            <Button data-testid="resume" onClick={() => ctx.resume(record)} disabled={ctx.startBlocker !== null}>
              Resume swap
            </Button>
          </ButtonRow>
          {ctx.startBlocker && <p className="small">{ctx.startBlocker}</p>}
        </Notice>
      )}
      {(record?.deterministic ?? snap?.deterministic) === false && !finished && (
        <Notice tone="danger" className="panel-intro" data-testid="nondet-warning" title="Keep this tab open.">
          Your wallet does not sign the start message the same way twice, so this swap cannot be recovered if this tab
          closes before it is done.
        </Notice>
      )}
      {snap?.outage && (
        // P4.5: a passing sponsor outage is waited out; this is a note, not a stop.
        <Notice tone="info" role="status" className="panel-intro" data-testid="sponsor-outage">
          {snap.outage}
        </Notice>
      )}
      {snap?.notice && (
        <Notice tone="warning" role="status" className="panel-intro" data-testid="swap-notice">
          {snap.notice}
        </Notice>
      )}
      {conflict && (
        <Notice
          tone="danger"
          role="alert"
          className="panel-intro"
          data-testid="arrival-conflict"
          title="Your tokens arrived, but the bridge reports something else."
        >
          {conflict}
        </Notice>
      )}
      {status?.kind === 'error' && (
        <Notice tone="danger" role="alert" className="panel-intro" data-testid="swap-error" title="The swap stopped.">
          {status.message}
          {status.canRetry && (
            <ButtonRow className="gap-top">
              <Button data-testid="retry" onClick={() => session?.retry()}>
                Retry
              </Button>
            </ButtonRow>
          )}
          {status.canResume && (
            <p className="small gap-top" data-testid="can-resume">
              The sponsor can revive this swap: resume it (above) with one signature of the start message and the
              sponsor authorisation.
            </p>
          )}
        </Notice>
      )}
      {record && <LostNotice record={record} network={network} />}

      <Panel
        title="Progress"
        meta={
          record ? (
            <span className="small muted">
              {APP_NAME} · {network.name}
            </span>
          ) : null
        }
      >
        <StageTracker stages={stages} label="Swap progress" data-testid="swap-stages" />
      </Panel>
      {record && <AllHashes record={record} network={network} />}
      {session && <NonDeterministicDialog session={session} open={status?.kind === 'confirm-nondeterministic'} />}
    </section>
  );
}

const legOf = (l: {
  token: { symbol: string; midnightName: string; decimals: number; midnightColour: string };
  amount: bigint;
}) => ({
  colour: l.token.midnightColour,
  symbol: l.token.symbol,
  midnightName: l.token.midnightName,
  decimals: l.token.decimals,
  amount: l.amount.toString(),
});
