// The review before a swap starts: what you pay and receive (on Sepolia), the price and expiry, what
// will happen and how long it takes, what your wallet will ask (three signatures, then two
// transactions), whether you hold enough, and "Start swap".

import { type SwapOffer, timeToExpiryMs } from '@evm-midnight-transparent/core';
import { useEffect, useState } from 'react';

import { APP_NAME } from '../../brand.js';
import { Button, ButtonLink, ButtonRow, Card, Hash, Money, Notice, Step, Steps } from '../../design/index.js';
import { amountText, ethText } from '../../swap/display.js';
import { BRIDGE_IN_ESTIMATE_MIN, SWAP_ESTIMATE_MIN, formatPriceRatio, formatTimeLeft } from '../../swap/offers.js';
import { useSwap } from '../../swap/SwapContext.js';

function useHoldings(offer: SwapOffer) {
  const { evm } = useSwap();
  const [held, setHeld] = useState<{ token: bigint; eth: bigint } | null>(null);
  useEffect(() => {
    if (!evm) return;
    let live = true;
    Promise.all([evm.erc20Balance(offer.pay.token.sepoliaAddress, evm.address), evm.ethBalance(evm.address)]).then(
      ([token, eth]) => live && setHeld({ token, eth }),
      () => live && setHeld(null),
    );
    return () => {
      live = false;
    };
  }, [evm, offer.pay.token.sepoliaAddress]);
  return evm ? held : null;
}

export function ReviewSwap({ offerId }: { offerId: string }) {
  const { feed, startBlocker, begin } = useSwap();
  const offer = feed.status === 'ready' ? feed.snapshot.offers.find((o) => o.offerId === offerId) : undefined;
  if (feed.status === 'loading')
    return (
      <p className="muted" role="status">
        Reading the exchange's offers…
      </p>
    );
  if (!offer)
    return (
      <Notice tone="warning" title="This offer is no longer in the book." data-testid="review-gone">
        Someone may have taken it, or it expired. <a href="#swap">Back to the offers</a>.
      </Notice>
    );
  return <Review offer={offer} blocker={startBlocker} onStart={() => begin(offer)} />;
}

function Review({ offer, blocker, onStart }: { offer: SwapOffer; blocker: string | null; onStart(): string | null }) {
  const { pay, receive } = offer;
  const held = useHoldings(offer);
  const [now] = useState(() => Date.now());
  const short = held !== null && held.token < pay.amount;
  const start = () => {
    const id = onStart();
    if (id) window.location.hash = `#swap?id=${id}`;
  };
  return (
    <Card title="Review the swap" data-testid="review-swap" meta={<a href="#swap">All offers</a>}>
      <div className="legs">
        <div className="leg" data-testid="review-pay">
          <span>
            You pay
            <span className="sub multiline">on Sepolia; bridged in as {pay.token.midnightName}</span>
          </span>
          <Money raw={pay.amount} decimals={pay.token.decimals} unit={pay.token.symbol} />
        </div>
        <div className="leg" data-testid="review-receive">
          <span>
            You receive
            <span className="sub multiline">on Sepolia; bridged out from {receive.token.midnightName}</span>
          </span>
          <Money raw={receive.amount} decimals={receive.token.decimals} unit={receive.token.symbol} />
        </div>
      </div>
      <dl className="kv">
        <dt>Price</dt>
        <dd>
          {formatPriceRatio(offer.price)} {pay.token.symbol} per {receive.token.symbol}
        </dd>
        <dt>Expires</dt>
        <dd>{formatTimeLeft(timeToExpiryMs(offer, now))}</dd>
        <dt>Offer</dt>
        <dd>
          <Hash value={offer.offerId} head={8} tail={6} />
        </dd>
        <dt>Takes</dt>
        <dd>about {SWAP_ESTIMATE_MIN} minutes or more</dd>
      </dl>

      <h4 className="panel-title-sm gap-top">What happens</h4>
      <Steps>
        <Step title="Start the swap: three signatures">
          Your wallet asks you to sign “Start a swap” twice. It is the same message: the signature creates this
          swap&apos;s temporary Midnight wallet, and signing twice checks that your wallet signs it the same way every
          time, so the swap can be recovered by signing again. Then a third signature lets {APP_NAME}&apos;s sponsor pay
          the Midnight fees for this swap.
        </Step>
        <Step title="Send the funds: two Sepolia transactions">
          A little Sepolia ETH for the bridge&apos;s sweep of your tokens (sized by the sponsor; most of it stays at the
          deposit address), then exactly {amountText(pay.amount, pay.token.decimals)} {pay.token.symbol}. Both go to the
          swap&apos;s deposit address, which this page computes from the temporary wallet and checks against the
          sponsor&apos;s.
        </Step>
        <Step title={`Bridge in: about ${BRIDGE_IN_ESTIMATE_MIN} minutes`}>
          The bridge waits for Sepolia finality and the MPC network&apos;s attestation, then mints{' '}
          {pay.token.midnightName} to the temporary wallet.
        </Step>
        <Step title="Take the offer on Midnight">
          The page takes the offer through the exchange, which pays its fee. If the offer is gone by then, the page says
          so and offers to bridge your tokens back.
        </Step>
        <Step title="Bridge out">
          {receive.token.midnightName} goes back to your address as {receive.token.symbol}: it arrives about a minute
          after the withdrawal starts; the bridge closes the request about 17 minutes later.
        </Step>
      </Steps>
      <p className="small muted gap-top">
        Keep this tab open while the swap runs. If it closes, open {APP_NAME} again with the same wallet and resume the
        swap from “Your swaps” by signing the start message again. Nothing about the swap&apos;s key is stored.
      </p>

      {held !== null && (
        <Notice
          tone={short ? 'warning' : 'info'}
          className="gap-top"
          data-testid="review-holdings"
          title={short ? `You hold less ${pay.token.symbol} than this swap pays.` : undefined}
        >
          Your wallet holds {amountText(held.token, pay.token.decimals)} {pay.token.symbol} and {ethText(held.eth)} on
          Sepolia.
        </Notice>
      )}
      {blocker && (
        <Notice tone="warning" className="gap-top" data-testid="start-blocker">
          {blocker}
        </Notice>
      )}
      <ButtonRow className="gap-top" stretch>
        <Button data-testid="start-swap" disabled={blocker !== null || short} onClick={start}>
          Start swap
        </Button>
        <ButtonLink href="#swap" variant="secondary">
          Back
        </ButtonLink>
      </ButtonRow>
    </Card>
  );
}
