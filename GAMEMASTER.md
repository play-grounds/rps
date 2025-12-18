# Game Master Protocol

A generalized protocol for turn-based games on Nostr with Bitcoin settlement.

## Concept

A **Game Master** is a specialized agent that:
- Knows the rules of one or more games
- Watches for player moves on Nostr
- Validates state transitions
- Settles outcomes
- Builds reputation through its trail

The game master is separate from the game itself. One master can run many games. Many masters can run the same game type.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     GAME MASTER MARKET                       │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│   ┌─────────────┐  ┌─────────────┐  ┌─────────────┐         │
│   │ Chess-GM-01 │  │ RPS-Agent   │  │ Poker-House │         │
│   │ ● Online    │  │ ● Online    │  │ ○ Offline   │         │
│   │ ★★★★☆      │  │ ★★☆☆☆      │  │ ★★★★★      │         │
│   │ 847 games   │  │ 23 games    │  │ 12k games   │         │
│   └─────────────┘  └─────────────┘  └─────────────┘         │
│                                                              │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                      GAME MASTER CORE                        │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│   ┌─────────────┐     ┌─────────────┐     ┌─────────────┐   │
│   │   Watcher   │────▶│  Validator  │────▶│   Settler   │   │
│   │             │     │             │     │             │   │
│   │ Nostr sub   │     │ Game rules  │     │ Balances    │   │
│   │ Event queue │     │ State check │     │ Payouts     │   │
│   └─────────────┘     └─────────────┘     └─────────────┘   │
│          │                   │                   │          │
│          └───────────────────┴───────────────────┘          │
│                              │                              │
│                              ▼                              │
│                      ┌─────────────┐                        │
│                      │    Trail    │                        │
│                      │             │                        │
│                      │ All history │                        │
│                      │ = Reputation│                        │
│                      └─────────────┘                        │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

## Separation of Concerns

```
┌─────────────────────┐
│    Game Master      │  Generic: any turn-based game
├─────────────────────┤
│ - Watch events      │
│ - Manage balances   │
│ - Record to trail   │
│ - Announce status   │
│ - Handle disputes   │
└─────────┬───────────┘
          │ implements
          ▼
┌─────────────────────┐
│    Game Rules       │  Specific: chess, poker, RPS, etc.
├─────────────────────┤
│ - Valid moves       │
│ - State transitions │
│ - Win conditions    │
│ - Draw conditions   │
│ - Timeout rules     │
└─────────────────────┘
```

**Example: Pluggable Games**

```javascript
// Game Master loads game rules
const gameMaster = new GameMaster({
  games: {
    'rps': RPSRules,
    'chess': ChessRules,
    'prediction': PredictionRules
  }
});

// Each game defines its interface
class RPSRules {
  validMoves = ['rock', 'paper', 'scissors'];

  validateMove(move, gameState) { ... }

  determineWinner(moves) { ... }

  isGameOver(gameState) { ... }
}
```

## Sealed Moves (Commit-Reveal)

### How It Works

For games with hidden information (most games), players seal their moves:

```
COMMIT PHASE:
┌─────────────────────────────────────────────────────────┐
│                                                          │
│   Player A                          Player B             │
│   ─────────                          ─────────           │
│   move = "rock"                      move = "paper"      │
│   nonce = random_32_bytes            nonce = random_32   │
│                                                          │
│   commit = SHA256(move + nonce)      commit = SHA256(...)│
│   = "a1b2c3..."                      = "d4e5f6..."       │
│                                                          │
│   ┌─────────────┐                    ┌─────────────┐     │
│   │ Publish     │                    │ Publish     │     │
│   │ commit hash │                    │ commit hash │     │
│   └──────┬──────┘                    └──────┬──────┘     │
│          │                                  │            │
│          └──────────────┬───────────────────┘            │
│                         ▼                                │
│                   ┌───────────┐                          │
│                   │   Nostr   │                          │
│                   │  (public) │                          │
│                   └───────────┘                          │
│                                                          │
│   At this point:                                         │
│   - Both moves are LOCKED (can't change hash)            │
│   - Neither knows opponent's move                        │
│   - Game Master sees commits                             │
│                                                          │
└─────────────────────────────────────────────────────────┘

REVEAL PHASE:
┌─────────────────────────────────────────────────────────┐
│                                                          │
│   After both commits received, players reveal:           │
│                                                          │
│   Player A publishes:        Player B publishes:         │
│   { move: "rock",            { move: "paper",            │
│     nonce: "xyz..." }          nonce: "abc..." }         │
│                                                          │
│   Game Master verifies:                                  │
│   SHA256("rock" + "xyz...") == "a1b2c3..." ✓            │
│   SHA256("paper" + "abc...") == "d4e5f6..." ✓           │
│                                                          │
│   Result: Paper beats Rock → Player B wins               │
│                                                          │
└─────────────────────────────────────────────────────────┘
```

### Limitations of Sealed Moves

#### 1. Abandonment Problem

```
What if a player commits but never reveals?

Timeline:
  T=0   Player A commits
  T=1   Player B commits
  T=2   Player A sees both commits, knows they lost
  T=3   Player A... just leaves. Never reveals.

Problem: Game can't complete. No one knows moves.

Solutions:
  - Timeout: After X minutes, non-revealer forfeits
  - Stake slashing: Non-revealer loses stake regardless
  - Bonds: Require reveal bond, returned on reveal
```

#### 2. Last-Revealer Advantage

```
If reveals are sequential (not simultaneous):

  T=0   Both commit
  T=1   Player A reveals "rock"
  T=2   Player B sees A's move before revealing

Problem: B now knows outcome before revealing.
         B could abandon if losing (see #1)

Solutions:
  - Timed reveals: Both must reveal within window
  - Simultaneous: Game master waits for both
  - No advantage: Abandonment = loss anyway
```

#### 3. Collision Attacks

```
What if two different moves hash to same value?

SHA256("rock" + nonce1) == SHA256("paper" + nonce2) ?

Reality: Computationally infeasible (2^256 space)
         Not a practical concern.

But: Weak hash functions or short nonces could be attacked.
     Always use SHA256 + 32-byte random nonce.
```

#### 4. Nonce Reuse

```
If player reuses nonces across games:

Game 1: commit = SHA256("rock" + "my_nonce")
Game 2: commit = SHA256("rock" + "my_nonce")  ← SAME!

Problem: Opponent sees same commit, knows it's same move.

Solution: Always generate fresh random nonce per move.
```

#### 5. Side Channels

```
Information leaks outside the protocol:

- Timing: Fast commit might indicate simple move
- Network: IP correlation between players
- Behavior: Historical patterns ("always opens rock")

These are outside protocol scope but affect fairness.
```

## Limitations of Finality

### What "Finality" Means Here

```
Bitcoin finality:      Probabilistic, economic (6 confirms ≈ final)
Blocktrail finality:   Social, reputational (published = can't unsay)

Key difference:
- Bitcoin: Reversal requires mass compute attack
- Nostr: Reversal requires... deleting an event?
         But witnesses (relays, players) still have it
```

### The Finality Spectrum

```
WEAK ◄─────────────────────────────────────────────► STRONG

  Verbal       Nostr        Bitcoin      Bitcoin
  promise      event        0-conf       6-conf
     │            │            │            │
     │            │            │            └── Practically irreversible
     │            │            └── Reversible with effort
     │            └── Published but relay-dependent
     └── No record
```

### Specific Limitations

#### 1. Relay Dependency

```
Events exist on relays. Relays can:

- Go offline      → Events inaccessible
- Delete events   → History lost (on that relay)
- Censor events   → Some moves hidden
- Disagree        → Different relays, different history

Mitigation:
- Multiple relays (redundancy)
- Local copies (trail file)
- Signed events (can prove event existed)
```

#### 2. Timestamp Trust

```
Nostr events have timestamps, but:

- Timestamps are self-reported (player sets them)
- No proof-of-work ordering
- Relays may receive events out of order

Problem: Player could backdate an event
         "I actually played at T=0, not T=5"

Mitigation:
- Relay timestamps (when received)
- Sequence numbers in game state
- Game master is source of truth for ordering
```

#### 3. No Global Consensus

```
Unlike blockchain, Nostr has no global state:

Relay A sees:  [commit_A, commit_B, reveal_A, reveal_B]
Relay B sees:  [commit_A, reveal_A, commit_B, reveal_B]

Which ordering is "true"?

Answer: Game master's view is canonical.
        Other views are witnesses.

Trade-off: Centralized trust in game master
           vs decentralized but ambiguous ordering
```

#### 4. Eclipse Attacks

```
What if game master only connects to attacker's relay?

- Attacker controls what GM sees
- Can hide opponent's valid moves
- Can replay old moves

Mitigation:
- Multiple relay connections
- Players can challenge with evidence
- Reputation at stake
```

#### 5. Not Cryptographic Finality

```
Bitcoin: "It would cost $X billion to reverse this"
Nostr:   "It would cost reputation to deny this"

The finality is social/economic, not cryptographic:
- Game master's reputation is collateral
- Cheating GM loses future business
- But no mathematical impossibility of cheating
```

### When Nostr Finality Is Enough

```
✓ Low-stakes games (entertainment)
✓ Reputation-building phase
✓ Fast iteration (no block times)
✓ Free transactions

✗ High-stakes (use Bitcoin escrow)
✗ Adversarial environment (use multisig)
✗ Legal requirements (need audit trail)
```

## Game Master Market

### Discovery

Game masters announce themselves on Nostr:

```json
{
  "kind": 30336,
  "content": {
    "type": "gm_announcement",
    "name": "RPS-Agent-001",
    "games": ["rps"],
    "status": "online",
    "pubkey": "...",
    "btcAddress": "tb1p...",
    "stats": {
      "totalGames": 156,
      "totalVolume": 3200000,
      "disputes": 0,
      "uptime": 0.97
    },
    "terms": {
      "minStake": 1000,
      "maxStake": 100000,
      "feePercent": 1,
      "timeout": 300
    }
  }
}
```

### Selection Criteria

Players choose game masters based on:

| Factor | Weight | Notes |
|--------|--------|-------|
| Online status | High | Can't play with offline GM |
| Reputation | High | Games played, dispute rate |
| Game support | Required | Must support the game type |
| Terms | Medium | Stakes, fees, timeouts |
| Uptime | Medium | Reliability |

### Online vs Offline

```
ONLINE GAME MASTER:
┌────────────────────────────────┐
│ ● Status: Online               │
│ Responds: < 5 seconds          │
│ Games: Real-time               │
│ Settlement: Immediate          │
└────────────────────────────────┘

OFFLINE GAME MASTER:
┌────────────────────────────────┐
│ ○ Status: Offline              │
│ Responds: When back online     │
│ Games: Async / correspondence  │
│ Settlement: Delayed            │
│                                │
│ Use case:                      │
│ - Correspondence chess         │
│ - Prediction markets           │
│ - Auctions with deadlines      │
└────────────────────────────────┘
```

### Reputation System

```
Trust is earned through:

1. Volume
   └── More games = more samples

2. Clean history
   └── Low dispute rate

3. Consistency
   └── Uptime, response time

4. Age
   └── Older trails harder to fake

Trust score = f(games, volume, disputes, age)

Display:
  ☆☆☆☆☆  New (< 5 games)
  ★☆☆☆☆  Verified (5+ games)
  ★★☆☆☆  Active (20+ games)
  ★★★☆☆  Established (50+ games)
  ★★★★☆  Trusted (200+ games, <1% disputes)
  ★★★★★  Elite (1000+ games, 0% disputes, 1yr+)
```

## Protocol Flow

### Complete Game Lifecycle

```
1. DISCOVERY
   Player → Nostr: Query kind:30336 (GM announcements)
   Player ← Nostr: List of active game masters
   Player: Select GM based on reputation/terms

2. REGISTRATION
   Player → GM: { type: "register", btcAddress: "..." }
   GM → Player: { type: "registered", balance: 0 }

3. FUNDING
   Player → GM: { type: "faucet_request" }  // or deposit
   GM → Player: { type: "funded", balance: 50000 }

4. GAME START
   Player A → Nostr: { type: "game_request", game: "rps", stake: 10000 }
   Player B → Nostr: { type: "game_accept", gameId: "..." }
   GM → Nostr: { type: "game_started", gameId: "...", players: [...] }

5. COMMIT PHASE
   Player A → Nostr: { type: "commit", hash: "..." }
   Player B → Nostr: { type: "commit", hash: "..." }
   GM: Records commits, waits for both

6. REVEAL PHASE
   Player A → Nostr: { type: "reveal", move: "rock", nonce: "..." }
   Player B → Nostr: { type: "reveal", move: "paper", nonce: "..." }
   GM: Verifies reveals match commits

7. RESOLUTION
   GM: Applies game rules, determines winner
   GM: Updates balances (winner +stake, loser -stake)
   GM → Nostr: { type: "game_resolved", winner: "...", proof: {...} }
   GM: Records to trail

8. WITHDRAWAL (optional)
   Player → GM: { type: "withdraw", amount: 50000 }
   GM → Bitcoin: Send transaction
   GM → Player: { type: "withdrawn", txid: "..." }
```

## Implementation Roadmap

### Phase 1: Current (RPS Agent)
- Single game type (RPS)
- Monolithic agent
- Faucet-funded testing
- Single relay

### Phase 2: Modular Game Master
- Separate GM core from game rules
- Plugin architecture for games
- Multiple relay support
- Better state management

### Phase 3: Game Master Market
- Discovery protocol
- Reputation aggregation
- GM comparison UI
- Terms negotiation

### Phase 4: Trustless Settlement
- 2-of-3 multisig escrow
- Dispute resolution protocol
- Cryptographic proofs
- Reduced GM trust requirements

## Summary

| Component | Current | Future |
|-----------|---------|--------|
| Game Master | Hardcoded in agent.js | Separate module |
| Games | RPS only | Pluggable rules |
| Discovery | Manual | Nostr-based market |
| Trust | Trail-based | Trail + multisig |
| Finality | Social/reputational | + Bitcoin anchoring |

The game master abstraction enables:
- **Specialization**: Masters focus on specific games
- **Competition**: Multiple masters, player choice
- **Innovation**: New games without new infrastructure
- **Trust markets**: Reputation becomes valuable
