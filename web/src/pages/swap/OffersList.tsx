// The offers list: every live offer whose two legs the vault bridges, not expiring within 45 minutes,
// straight from the exchange's book and kept live by its offer stream. No token rules: a row is "you
// pay the offer's wanted leg, you receive its given leg", with the exact price and the expiry.

import { type SwapOffer, timeToExpiryMs } from '@evm-midnight-transparent/core';
import { useEffect, useState } from 'react';

import {
  Button,
  ButtonLink,
  Cell,
  EmptyState,
  Money,
  Notice,
  Panel,
  StatementTable,
  StatusPill,
  Sub,
} from '../../design/index.js';
import { clockText } from '../../swap/display.js';
import { formatPriceRatio, formatTimeLeft, formatUtc, invert, listOffers } from '../../swap/offers.js';
import { useSwap } from '../../swap/SwapContext.js';

/** Re-render every `ms` (the expiry column counts down; offers leave the list at 45 minutes). */
function useNow(ms: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

function OfferRow({ offer, now }: { offer: SwapOffer; now: number }) {
  const { pay, receive } = offer;
  return (
    <tr
      data-testid="offer-row"
      data-offer-id={offer.offerId}
      data-pay={pay.token.symbol}
      data-receive={receive.token.symbol}
    >
      <Cell label="You pay" data-testid="offer-pay">
        <span>
          <Money raw={pay.amount} decimals={pay.token.decimals} unit={pay.token.symbol} />
          <Sub multiline>from Sepolia, as {pay.token.midnightName}</Sub>
        </span>
      </Cell>
      <Cell label="You receive" data-testid="offer-receive">
        <span>
          <Money raw={receive.amount} decimals={receive.token.decimals} unit={receive.token.symbol} />
          <Sub multiline>to Sepolia, from {receive.token.midnightName}</Sub>
        </span>
      </Cell>
      <Cell label="Price" align="right" data-testid="offer-price">
        <span>
          <span className="num">
            {formatPriceRatio(offer.price)} {pay.token.symbol}
          </span>
          <Sub multiline>
            per {receive.token.symbol} · {formatPriceRatio(invert(offer.price))} {receive.token.symbol} per{' '}
            {pay.token.symbol}
          </Sub>
        </span>
      </Cell>
      <Cell label="Expires" align="right" num data-testid="offer-expires" title={formatUtc(offer.expiresAt)}>
        {formatTimeLeft(timeToExpiryMs(offer, now))}
      </Cell>
      <Cell label="" align="right">
        <ButtonLink
          variant="primary"
          size="small"
          href={`#swap?offer=${offer.offerId}`}
          data-testid="offer-swap"
          aria-label={`Swap: pay ${pay.token.symbol}, receive ${receive.token.symbol}`}
        >
          Swap
        </ButtonLink>
      </Cell>
    </tr>
  );
}

export function OffersList() {
  const { feed, refreshFeed } = useSwap();
  const now = useNow(30_000);
  const stream =
    feed.stream === 'live' ? (
      <StatusPill status="live">Live</StatusPill>
    ) : feed.stream === 'polling' ? (
      <StatusPill status="progress">Refreshing every 15 s</StatusPill>
    ) : (
      <StatusPill status="idle">Connecting</StatusPill>
    );
  const meta = (
    <span className="feed" data-testid="feed-status" data-status={feed.status} data-stream={feed.stream}>
      {stream}
      {feed.status === 'ready' ? <span>updated {clockText(feed.updatedAt)}</span> : null}
      <Button variant="link" onClick={refreshFeed} data-testid="feed-refresh">
        Refresh
      </Button>
    </span>
  );

  let body;
  if (feed.status === 'loading') {
    body = (
      <p className="muted" role="status">
        Reading the exchange's offers…
      </p>
    );
  } else if (feed.status === 'unavailable') {
    body = (
      <Notice tone="danger" role="alert" title="The exchange is unavailable." data-testid="exchange-unavailable">
        {feed.reason[0]!.toUpperCase() + feed.reason.slice(1)}. This page tries again on its own.
      </Notice>
    );
  } else {
    const { offers, expiringSoon } = listOffers(feed.snapshot, now);
    const ignored = Object.values(feed.snapshot.ignored).reduce((a, b) => a + b, 0);
    body = (
      <>
        {offers.length === 0 ? (
          <EmptyState title="No offers to swap right now" data-testid="offers-empty">
            New offers show up here as soon as the exchange indexes them.
          </EmptyState>
        ) : (
          <StatementTable
            data-testid="offers"
            caption="Offers you can take"
            columns={[
              { label: 'You pay' },
              { label: 'You receive' },
              { label: 'Price', align: 'right' },
              { label: 'Expires', align: 'right' },
              { label: 'Action', srOnly: true, align: 'right' },
            ]}
          >
            {offers.map((o) => (
              <OfferRow key={o.offerId} offer={o} now={now} />
            ))}
          </StatementTable>
        )}
        <p className="table-note" data-testid="offers-note">
          {offers.length} {offers.length === 1 ? 'offer' : 'offers'}
          {expiringSoon > 0 ? ` · ${expiringSoon} expiring within 45 minutes not shown (a swap takes about 20)` : ''}
          {ignored > 0 ? ` · ${ignored} the bridge cannot carry not shown` : ''}
          {feed.complete ? '' : ' · the book has more offers than this page reads'}
        </p>
      </>
    );
  }

  return (
    <Panel title="Offers" meta={meta} data-testid="offers-panel">
      {body}
    </Panel>
  );
}
