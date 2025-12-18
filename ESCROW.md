# Escrow Agent

A trust-building escrow agent for games on Nostr with Bitcoin payments.

## Concept

The escrow agent is a neutral third party that:
- Watches for games on Nostr
- Verifies outcomes (commit-reveal)
- Settles balances between players
- Builds reputation through its **trail**

The agent's trail IS its reputation. Every game arbitrated is recorded, creating a verifiable history that builds trust over time.

## Turn-Based Finality

Blocktrails provide turn-based finality for state machines:

```
Turn 1: Commit    → Hash published, move locked (can't change)
Turn 2: Reveal    → Move verified against hash
Turn 3: Resolve   → Winner determined, balances settled
```

Each turn is:
- **Published** - can't be unsaid
- **Ordered** - happened at specific time
- **Verifiable** - anyone can check
- **Permanent** - part of the trail

## Trust Levels

Agents earn trust through volume and clean history:

| Level       | Requirements              | Color  |
|-------------|---------------------------|--------|
| New         | < 5 games                 | Gray   |
| Verified    | 5+ games                  | Green  |
| Established | 30+ score                 | Blue   |
| Trusted     | 60+ score                 | Purple |

**Trust Score Formula:**
- Games: up to 40 points (100+ games = max)
- Volume: up to 40 points (1M+ sats = max)
- Disputes: up to 20 points (0% = max)

## Architecture

```
┌─────────────┐      Nostr Events       ┌─────────────┐
│   Player A  │ ◄─────────────────────► │   Agent     │
└─────────────┘                         │             │
                                        │  - Trail    │
┌─────────────┐                         │  - Keys     │
│   Player B  │ ◄─────────────────────► │  - Balance  │
└─────────────┘                         └──────┬──────┘
                                               │
                                               ▼
                                        ┌─────────────┐
                                        │  Bitcoin    │
                                        │  (testnet4) │
                                        └─────────────┘
```

## Protocol

### Nostr Event Kinds

| Kind  | Purpose           |
|-------|-------------------|
| 30334 | Game state, requests (faucet, register, withdraw) |
| 30335 | Game moves (commit, reveal) |
| 30336 | Agent announcements |
| 30337 | Agent responses |

### Message Types

**Player → Agent:**

```json
// Faucet request (get starting balance)
{ "type": "faucet_request", "btcAddress": "tb1p..." }

// Register BTC address
{ "type": "register", "btcAddress": "tb1p..." }

// Query balance
{ "type": "balance_query" }

// Query head-to-head vs opponent
{ "type": "matchup_query", "opponent": "<pubkey>" }

// Withdraw to on-chain
{ "type": "withdraw", "amount": 50000 }
```

**Agent → Player:**

```json
// Faucet response
{ "type": "faucet_response", "success": true, "txid": "...", "amount": 50000 }

// Balance response
{ "type": "balance_response", "balance": 50000, "wins": 3, "losses": 1 }

// Matchup response
{ "type": "matchup_response", "opponent": "...", "wins": 2, "losses": 1, "draws": 0 }

// Withdraw response
{ "type": "withdraw_response", "success": true, "txid": "...", "newBalance": 0 }

// Game resolved
{ "type": "game_resolved", "gameId": "...", "winner": "<pubkey>", "players": {...} }
```

## Player Balances

Players have an **agent balance** (account with agent) separate from their on-chain balance:

```
┌────────────────────────────────────┐
│  On-chain: 50,000 sats             │  ← Actual BTC in your address
│  Agent:    30,000 sats (W:3 L:1)   │  ← Balance for games
└────────────────────────────────────┘
```

- **Faucet** credits agent balance (50k sats)
- **Games** settle between agent balances
- **Withdraw** moves agent balance → on-chain

## Trail Structure

The agent's trail (`.agent-trail.json`) records everything:

```json
{
  "version": 2,
  "type": "escrow_agent",
  "name": "RPS-Agent-001",
  "created": 1766039175660,
  "games": [
    {
      "id": "rps:abc123",
      "players": ["pubkeyA", "pubkeyB"],
      "stake": 10000,
      "winner": "pubkeyA",
      "timestamp": 1766039606464,
      "commits": { ... },
      "reveals": { ... }
    }
  ],
  "players": {
    "<pubkey>": {
      "btcAddress": "tb1p...",
      "balance": 30000,
      "wins": 3,
      "losses": 1,
      "matchups": {
        "<opponent_pubkey>": { "wins": 2, "losses": 1, "draws": 0 }
      }
    }
  },
  "faucet": {
    "recipients": { ... },
    "totalPaid": 200000
  },
  "stats": {
    "totalGames": 15,
    "totalVolume": 300000,
    "disputes": 0
  }
}
```

## Running the Agent

```bash
# Install dependencies
npm install

# Start agent (watches for games)
npm run agent

# Check status and balance
npm run agent:status

# View full trail
npm run agent:trail

# Manual payment
npm run agent:pay <address> <amount_sats>
```

## Configuration

In `agent.js`:

```javascript
const CONFIG = {
  relay: 'wss://nos.lol',
  trailFile: '.agent-trail.json',
  keyFile: '.agent-key.json',
  network: 'tbtc4',
  mempoolApi: 'https://mempool.space/testnet4/api',
  feeRate: 2,        // sats/vbyte
  stakeAmount: 10000, // per game
  faucetAmount: 50000 // for new players
};
```

## Bitcoin Integration

The agent uses **Taproot (P2TR)** addresses on testnet4:
- Native Schnorr signatures
- Future: 2-of-3 multisig that looks like single-sig
- Addresses start with `tb1p...`

**Payment flow:**
1. Agent holds funds in its Taproot address
2. Faucet sends from agent → player address
3. Withdrawals send from agent → player address
4. Game settlements are internal (balance ledger)

## Security Considerations

Current limitations:
- Agent runs locally (centralized)
- Keys in plaintext files
- No 2-of-3 multisig (agent is trusted)
- Single relay point of failure

Production would need:
- HSM or secure key storage
- Multiple relays
- True 2-of-3 escrow
- Dispute resolution mechanism

## Future: True Escrow

For trustless escrow, use 2-of-3 Taproot multisig:

```
Spending paths:
1. Player A + Player B  (mutual agreement)
2. Player A + Agent     (agent sides with A)
3. Player B + Agent     (agent sides with B)
```

All paths look identical on-chain until spent (Taproot privacy).

## NATEOS

**N**ostr **A**s **T**he **E**ngine **O**f **S**tate

The game state machine runs on Nostr:
- Events are state transitions
- Subscriptions are state queries
- The relay is the broadcast layer
- Bitcoin is the settlement layer

This separates concerns:
- **Nostr**: Fast, free, real-time state
- **Bitcoin**: Slow, expensive, final settlement
