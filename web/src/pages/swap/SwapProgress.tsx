// One swap's page: six stages with every hash as it lands (spec US1), "Swap is not available" with
// Bridge back (Q6), the determinism warning (Q4), refund retries (Q9 A), and Resume for a swap that
// is not running in this tab (US2.2).

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
import { amountText, clockText, elapsedText, ethText, legText } from '../../swap/display.js';
import { type StageKey, stageStates, stageTitle } from '../../swap/flow.js';
import { bridgeRequestUrl, midnightTxUrl, sepoliaAddressUrl, sepoliaTxUrl } from '../../swap/links.js';
import { BRIDGE_IN_ESTIMATE_MIN } from '../../swap/offers.js';
import { type SwapRecord, isFinished } from '../../swap/record-shape.js';
import type { SessionSnapshot, SessionStatus, SwapSession } from '../../swap/session.js';
import { useSession, useSwap } from '../../swap/SwapContext.js';

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
  'start-1': 'Sign “Start a swap” in your wallet (signature 1 of 3).',
  'start-2':
    'Sign the same “Start a swap” message again (2 of 3): this checks that your wallet signs it the same way every time.',
  sponsor: 'Sign the sponsor authorisation (the last signature): it lets the sponsor pay this swap’s Midnight fees.',
  resume: 'Sign “Start a swap” again: it re-creates this swap’s temporary Midnight wallet.',
};

function statusLine(snap: SessionSnapshot | null, record: SwapRecord | null): string {
  if (!snap) return record && isFinished(record) ? 'Finished.' : 'Not running in this tab.';
  const s = snap.status;
  switch (s.kind) {
    case 'signing':
      return PROMPT[s.prompt];
    case 'confirm-nondeterministic':
      return 'Your wallet signed differently the second time: decide whether to continue.';
    case 'opening':
      return 'Opening the swap with the sponsor…';
    case 'fund':
      return s.sending === 'confirming'
        ? 'Waiting for the sweep gas transfer to be confirmed on Sepolia before the token transfer.'
        : s.sending
          ? 'Confirm the transfers in your wallet.'
          : 'Send the funds to start the bridge.';
    case 'working':
      return `${s.what}…`;
    case 'unavailable':
      return 'Swap is not available.';
    case 'done':
      return record?.outcome === 'bridged-back' ? 'Bridged back.' : 'Done.';
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

  const running = !!session && !session.isClosed;
  const status = snap?.status ?? null;
  const offer = record?.offer ?? null;
  const pay = offer?.pay ?? (snap?.offer ? { ...legOf(snap.offer.pay) } : null);
  const receive = offer?.receive ?? (snap?.offer ? { ...legOf(snap.offer.receive) } : null);
  const states = stageStates(record);
  const finished = !!record && isFinished(record);
  const unavailable = record?.phase === 'unavailable';
  const back = record?.choice === 'bridge-back';

  const startDetail = (
    <>
      {status?.kind === 'signing' && <p data-testid="sign-prompt">{PROMPT[status.prompt]}</p>}
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
      {status?.kind === 'fund' && (
        <ButtonRow stretch>
          <Button data-testid="send-funds" disabled={fundStatus !== null} onClick={() => void session?.sendFunds()}>
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

  const inStart = record?.bridgeIn.stages?.[0]?.at;
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
      {back && !unavailable && <p>The offer was not available; you chose to bridge your tokens back.</p>}
      {status?.kind === 'working' && record.phase === 'taking' && <p>{status.what}…</p>}
      {!unavailable && !back && <p className="small">Taken through the exchange, which pays the fee.</p>}
      <ul className="tx-list">
        <TxLine name="take" label="Taken" hash={record.take.tx} kind="midnight" network={network} />
      </ul>
    </>
  );

  const outLeg = record ? (back ? record.offer.pay : record.offer.receive) : null;
  const bridgeOutDetail = record && outLeg && (
    <>
      <p className="small">
        {legText(outLeg)} to your address: it arrives about a minute after the withdrawal starts; the bridge closes the
        request about 17 minutes later.
      </p>
      {record.bridgeOut.sepoliaTx && (
        <p data-testid="arrived">
          <strong>
            {legText(outLeg)} {back ? 'came back' : 'arrived'} on Sepolia.
          </strong>
        </p>
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
          refunded to the temporary wallet and retried.
        </p>
      )}
    </>
  );

  const doneDetail = record?.phase === 'done' && (
    <p data-testid="done-summary">
      {record.outcome === 'bridged-back'
        ? `The swap did not happen: ${legText(record.offer.pay)} came back to your address.`
        : `You paid ${legText(record.offer.pay)} and received ${legText(record.offer.receive)}.`}{' '}
      The temporary wallet is empty.
    </p>
  );

  const titles: Record<StageKey, string> = {
    start: 'Start swap',
    fund: 'Send funds',
    'bridge-in': `Bridge in${pay ? ` ${pay.midnightName}` : ''}`,
    take: unavailable || back ? 'Swap is not available' : 'Take the offer',
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
      aria-labelledby="swap-title"
    >
      <PageHead
        eyebrow="Swap"
        title={title}
        titleId="swap-title"
        lede={statusLine(snap, record)}
        actions={<a href="#swap">All offers</a>}
      />

      {!running && record && !finished && (
        <Notice
          tone="warning"
          title="This swap is not running in this tab."
          className="panel-intro"
          data-testid="resume-here"
        >
          Resume it: your wallet signs the swap&apos;s “Start a swap” message once (it re-creates the swap&apos;s
          Midnight wallet), then the sponsor authorisation once.
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
      {snap?.notice && (
        <Notice tone="warning" role="status" className="panel-intro" data-testid="swap-notice">
          {snap.notice}
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
        </Notice>
      )}

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
