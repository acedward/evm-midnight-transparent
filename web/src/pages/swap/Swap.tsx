// The Swap section: the offers list and your swaps (#swap), the review of one offer
// (#swap?offer=<id>), and one swap's page (#swap?id=<swap id>).

import { useEffect, useState } from 'react';

import { APP_NAME } from '../../brand.js';
import { Notice, PageHead } from '../../design/index.js';
import { SWAP_ESTIMATE_MIN } from '../../swap/offers.js';
import { useSwap } from '../../swap/SwapContext.js';
import { useWallet } from '../../wallet/WalletContext.js';
import { OffersList } from './OffersList.js';
import { ReviewSwap } from './ReviewSwap.js';
import { SwapProgress } from './SwapProgress.js';
import { NoWalletYet, YourSwaps } from './YourSwaps.js';
import './swap.css';

const HEX64 = /^[0-9a-f]{64}$/;
const SWAP_ID = /^0x[0-9a-f]{64}$/;

/** The parameters after `#swap?`. */
function readRoute(): { offer?: string; id?: string } {
  const q = window.location.hash.split('?')[1] ?? '';
  const p = new URLSearchParams(q);
  const offer = p.get('offer')?.toLowerCase();
  const id = p.get('id')?.toLowerCase();
  return {
    ...(offer && HEX64.test(offer) ? { offer } : {}),
    ...(id && SWAP_ID.test(id) ? { id } : {}),
  };
}

function useRoute() {
  const [route, setRoute] = useState(readRoute);
  useEffect(() => {
    const on = () => setRoute(readRoute());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return route;
}

export function SwapSection() {
  const { backends, failure } = useSwap();
  const wallet = useWallet();
  const route = useRoute();
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [route.offer, route.id]);

  const mock = backends?.mock ? (
    <Notice tone="warning" className="panel-intro" data-testid="mock-banner" title="Mock mode.">
      {backends.mock.describe}
    </Notice>
  ) : null;

  if (failure)
    return (
      <section data-testid="section-swap">
        <PageHead title="Swap" />
        <Notice tone="danger" role="alert" data-testid="swap-failure">
          {APP_NAME} cannot list swaps: {failure}
        </Notice>
      </section>
    );

  if (route.id)
    return (
      <section data-testid="section-swap">
        {mock}
        <SwapProgress swapId={route.id} />
      </section>
    );

  return (
    <section data-testid="section-swap">
      <PageHead
        eyebrow="Offers from the exchange"
        title={route.offer ? 'Swap' : 'Swap from your EVM wallet'}
        lede={
          route.offer
            ? undefined
            : `Take an offer on Midnight with the tokens in your Sepolia wallet. Each swap bridges exactly what the offer wants into a temporary Midnight wallet made for that swap, takes the offer, and bridges what it gives back to you: about ${SWAP_ESTIMATE_MIN} minutes or more, with no Midnight wallet to install.`
        }
      />
      {mock}
      {route.offer ? (
        <ReviewSwap offerId={route.offer} />
      ) : (
        <>
          {wallet.status !== 'connected' && <NoWalletYet />}
          <YourSwaps />
          <div className="section-gap">
            <OffersList />
          </div>
        </>
      )}
    </section>
  );
}
