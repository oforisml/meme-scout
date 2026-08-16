# Edge Hypothesis — the thing Phase 3 exists to falsify

## H1 (primary)
Newly launched Solana meme coins that (a) pass hard safety filters
(authorities revoked, LP burned, acceptable concentration, non-throwaway
creator) AND (b) show early organic traction (unique-buyer growth without
wash-trade signatures) achieve positive median return at the 60-minute
horizon, net of realistic execution costs, relative to entering at alert
time — despite entering after block-zero bots.

Rationale for why this could be true: safety filtering removes the ~majority
of launches that are engineered to take money; among survivors, early
attention compounds reflexively for a short window, and most retail discovers
tokens later than an automated alerting pipeline does.

Rationale for why it could be false: everything alertable is already priced
in by faster bots; the fills a slower entrant can get are adversely selected;
survivors still overwhelmingly decay to zero after the first spike.

## H2 (secondary)
Repeat creators with a clean recorded history outperform first-time creators
among filter-passing tokens.

## H3 (secondary)
Tokens graduating from pump.fun to Raydium show a tradable post-migration
window.

## Falsification protocol
- Test on ≥4 weeks of recorded data, ≥200 filter-passing tokens.
- Expectancy computed per FSD FR-B3 (all costs itemised, bootstrap CI).
- H1 is REJECTED if the 95% CI of net expectancy includes zero or below.
- No threshold tuning on the same data used for the final verdict: tune on
  the first half of the recording window, verdict on the second half.
- A rejected H1 stops Phases 4–6 and triggers either a new written
  hypothesis or a pivot to the research/alerting product (FSD Module F).

## H4 (graduation momentum)
Tokens graduating from the pump.fun bonding curve to PumpSwap that show
continued unique-buyer growth in the first 10 minutes post-migration have
positive net expectancy at the 60-minute horizon. Rationale: graduation is a
public, latency-tolerant signal — a natural fit for our speed tier — and
migration burns LP, removing one rug vector.

## H5 (insider supply)
Among filter-passing tokens, those with bundled_supply_pct < 10% and no
deployer-funded snipers (Module H) materially outperform those above 15%,
because insider-heavy launches systematically dump on followers.

## H6 (narrative tailwind)
Tokens tagged to a meme family currently absorbing aggregate volume
(FR-I3) outperform untagged tokens at equal on-chain quality, because
attention flows rotate within families rather than arriving randomly.

## Falsification protocol addendum
H4-H6 follow the same protocol as H1: tune on the first half of the
recording window, verdict on the second half, bootstrap CI must exclude
zero net of costs.

Every future strategy idea gets added here as H4, H5... BEFORE being coded.
