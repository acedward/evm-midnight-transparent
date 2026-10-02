// What another party's vault settle took out of the temporary wallet's reach (plan 00048 P4.2-fix4,
// lane FS4; the audit's T1). Shown in every state while the record has lost parts: the swap then goes
// on with what is left (Bridge back of a partial deposit), or ended `failed` / `settled-elsewhere`.

import type { NetworkProfile } from '@evm-midnight-transparent/core';

import { Hash, Notice } from '../../design/index.js';
import { legText } from '../../swap/display.js';
import { bridgeRequestUrl, sepoliaTxUrl } from '../../swap/links.js';
import type { SwapRecord } from '../../swap/record-shape.js';
import { lostLeg } from '../../swap/settled-elsewhere.js';

export function LostNotice({ record, network }: { record: SwapRecord; network: NetworkProfile }) {
  const parts = record.lost ?? [];
  if (parts.length === 0) return null;
  const finished = record.phase === 'done' || record.phase === 'failed';
  return (
    <Notice
      tone="danger"
      className="panel-intro"
      data-testid="lost-notice"
      title="Part of this swap was completed by another party, and those funds are lost."
    >
      <ul className="tx-list">
        {parts.map((p, i) => {
          const leg = lostLeg(record, p);
          const href = p.evmTx
            ? sepoliaTxUrl(network, p.evmTx)
            : p.requestId
              ? bridgeRequestUrl(network, p.requestId)
              : null;
          return (
            <li key={`${p.requestId ?? p.evmTx ?? 'part'}-${i}`} className="tx-line" data-testid="lost-part">
              <strong className="num">{leg ? legText({ ...leg, amount: p.amount }) : `${p.amount} base units`}</strong>{' '}
              <span className="muted">{p.kind === 'deposit' ? 'bridged in' : 'refunded'} by another party</span>
              {(p.evmTx ?? p.requestId) && (
                <>
                  {' '}
                  <Hash value={(p.evmTx ?? p.requestId)!} head={8} tail={6} {...(href ? { href } : {})} />
                </>
              )}
            </li>
          );
        })}
      </ul>
      <p className="small gap-top">
        The bridge&apos;s vault lets anyone complete its requests. Here someone else did it first and kept the new
        coin&apos;s details to itself, so this swap&apos;s temporary wallet can never use that amount (nobody else can
        spend it either). {finished ? 'Nothing more can be recovered for it.' : 'The swap goes on with what is left.'}
      </p>
    </Notice>
  );
}
