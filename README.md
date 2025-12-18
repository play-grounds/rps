# RPS

Rock Paper Scissors on Nostr with commit-reveal.

## How It Works

```
1. CREATE: Player A creates game, gets game ID
2. JOIN:   Player B joins with game ID
3. COMMIT: Both players commit hash(move + salt)
4. REVEAL: Both players reveal move + salt
5. VERIFY: Hashes verified, winner determined
```

No cheating possible - you commit before you see opponent's move.

## Play

```bash
npm install
npm start
# Open http://localhost:3000
```

Or just open `index.html` directly.

## Protocol

### Game Events (Kind 30334)

```json
{
  "kind": 30334,
  "tags": [["d", "rps:abc123"], ["t", "rps"]],
  "content": {"type": "create", "creator": "<pubkey>"}
}
```

### Move Events (Kind 30335)

Commit:
```json
{
  "kind": 30335,
  "tags": [["g", "rps:abc123"], ["t", "rps-move"]],
  "content": {"type": "commit", "hash": "sha256(move:salt)"}
}
```

Reveal:
```json
{
  "kind": 30335,
  "tags": [["g", "rps:abc123"], ["t", "rps-move"]],
  "content": {"type": "reveal", "move": "rock", "salt": "x7k2..."}
}
```

## Why Commit-Reveal?

If you just broadcast your move, opponent sees it and picks the winning counter.

With commit-reveal:
1. You commit `hash("rock" + "randomsalt")`
2. Opponent commits their hash
3. Neither can change (hash is published)
4. Both reveal - hashes verified
5. Fair game!
