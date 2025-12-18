#!/usr/bin/env node
/**
 * RPS Escrow Agent
 *
 * An escrow agent that:
 * - Watches for RPS games on Nostr
 * - Creates 2-of-3 escrow addresses
 * - Verifies game outcomes
 * - Pays winners
 * - Records all games on its trail (reputation)
 */

import { generateSecretKey, getPublicKey, finalizeEvent, Relay } from 'nostr-tools';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { createHash, randomBytes } from 'crypto';
import * as bitcoin from 'bitcoinjs-lib';
import * as ecc from 'tiny-secp256k1';
import * as secp256k1 from '@noble/secp256k1';

// Initialize ECC library for Taproot
bitcoin.initEccLib(ecc);

// Testnet4 network definition
const testnet4 = {
  messagePrefix: '\x18Bitcoin Signed Message:\n',
  bech32: 'tb',
  bip32: { public: 0x043587cf, private: 0x04358394 },
  pubKeyHash: 0x6f,
  scriptHash: 0xc4,
  wif: 0xef
};

// ============================================
// Configuration
// ============================================

const CONFIG = {
  relay: 'wss://nos.lol',  // More permissive than damus
  trailFile: '.agent-trail.json',
  keyFile: '.agent-key.json',
  network: 'tbtc4',
  mempoolApi: 'https://mempool.space/testnet4/api',
  feeRate: 2,  // sats/vbyte
  stakeAmount: 10000,  // 10k sats per game
  faucetAmount: 50000  // 50k sats for new players
};

// ============================================
// Crypto Helpers
// ============================================

function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

function randomHex(bytes = 16) {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
}

// ============================================
// Bitcoin UTXO & Transaction Helpers
// ============================================

async function fetchUtxos(address) {
  const res = await fetch(`${CONFIG.mempoolApi}/address/${address}/utxo`);
  return res.json();
}

async function fetchBalance(address) {
  const utxos = await fetchUtxos(address);
  return utxos.reduce((sum, u) => sum + u.value, 0);
}

async function broadcastTx(txHex) {
  const res = await fetch(`${CONFIG.mempoolApi}/tx`, {
    method: 'POST',
    body: txHex
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Broadcast failed: ${err}`);
  }
  return res.text(); // Returns txid
}

function createPayoutTx(keyData, utxos, winnerAddress, amount) {
  const privkeyBytes = Buffer.from(keyData.btcPrivkey, 'hex');
  const fullPubkey = secp256k1.getPublicKey(privkeyBytes, true);
  const xOnlyPubkey = Buffer.from(fullPubkey.slice(1));

  // Select UTXOs (simple: use first one that's big enough)
  const utxo = utxos.find(u => u.value >= amount + 500); // 500 sats buffer for fee
  if (!utxo) {
    throw new Error(`No UTXO large enough. Need ${amount + 500}, have ${utxos.map(u => u.value).join(', ')}`);
  }

  // Calculate fee (Taproot tx ~111 vbytes for 1-in-1-out)
  const fee = CONFIG.feeRate * 150; // ~150 vbytes with change
  const change = utxo.value - amount - fee;

  // Build transaction manually for more control
  const tx = new bitcoin.Transaction();
  tx.version = 2;

  // Add input
  tx.addInput(Buffer.from(utxo.txid, 'hex').reverse(), utxo.vout);

  // Add winner output
  const winnerOutput = bitcoin.address.toOutputScript(winnerAddress, testnet4);
  tx.addOutput(winnerOutput, BigInt(amount));

  // Add change output if worthwhile
  if (change > 546) {
    const changeOutput = bitcoin.address.toOutputScript(keyData.btcAddress, testnet4);
    tx.addOutput(changeOutput, BigInt(change));
  }

  // Compute sighash for Taproot key-path spend
  const prevouts = [{
    script: bitcoin.payments.p2tr({
      internalPubkey: xOnlyPubkey,
      network: testnet4
    }).output,
    value: BigInt(utxo.value)
  }];

  const sighash = tx.hashForWitnessV1(
    0, // input index
    prevouts.map(p => p.script),
    prevouts.map(p => p.value),
    bitcoin.Transaction.SIGHASH_DEFAULT
  );

  // Compute tweaked private key for key-path spend
  const tweak = bitcoin.crypto.taggedHash('TapTweak', xOnlyPubkey);

  // Negate private key if pubkey has odd Y
  let privKey = privkeyBytes;
  if (fullPubkey[0] === 3) {
    privKey = Buffer.from(ecc.privateNegate(privkeyBytes));
  }

  // Add tweak
  const tweakedPrivKey = Buffer.from(ecc.privateAdd(privKey, tweak));

  // Sign with Schnorr
  const signature = Buffer.from(ecc.signSchnorr(sighash, tweakedPrivKey));

  // Set witness (just the signature for key-path spend)
  tx.setWitness(0, [signature]);

  return tx.toHex();
}

async function payWinner(keyData, winnerAddress, amount) {
  console.log(`Paying ${amount} sats to ${winnerAddress.slice(0, 12)}...`);

  const utxos = await fetchUtxos(keyData.btcAddress);
  if (utxos.length === 0) {
    console.log('No UTXOs available for payment');
    return null;
  }

  const txHex = createPayoutTx(keyData, utxos, winnerAddress, amount);
  const txid = await broadcastTx(txHex);
  console.log(`Payment broadcast: ${txid}`);
  return txid;
}

// ============================================
// Agent Key Management
// ============================================

function loadOrCreateKey() {
  if (existsSync(CONFIG.keyFile)) {
    const data = JSON.parse(readFileSync(CONFIG.keyFile, 'utf8'));

    // Add Bitcoin key if missing (migration)
    if (!data.btcPrivkey) {
      data.btcPrivkey = randomBytes(32).toString('hex');
    }

    // Regenerate address (handles format upgrades like P2WPKH -> P2TR)
    const newAddress = generateBtcAddress(data.btcPrivkey);
    if (data.btcAddress !== newAddress) {
      data.btcAddress = newAddress;
      writeFileSync(CONFIG.keyFile, JSON.stringify(data, null, 2));
      console.log(`Updated Bitcoin address: ${newAddress}`);
    }

    console.log(`Loaded agent key: ${data.pubkey.slice(0, 8)}...`);
    return data;
  }

  const secretKey = generateSecretKey();
  const pubkey = getPublicKey(secretKey);
  const secretKeyHex = Array.from(secretKey).map(b => b.toString(16).padStart(2, '0')).join('');

  // Generate Bitcoin key
  const btcPrivkey = randomBytes(32).toString('hex');
  const btcAddress = generateBtcAddress(btcPrivkey);

  const data = { secretKey: secretKeyHex, pubkey, btcPrivkey, btcAddress };
  writeFileSync(CONFIG.keyFile, JSON.stringify(data, null, 2));
  console.log(`Generated new agent key: ${pubkey.slice(0, 8)}...`);
  return data;
}

function generateBtcAddress(privkeyHex) {
  const privkeyBytes = Buffer.from(privkeyHex, 'hex');
  // For Taproot, we need the x-only pubkey (32 bytes, no prefix)
  const fullPubkey = secp256k1.getPublicKey(privkeyBytes, true);
  const xOnlyPubkey = fullPubkey.slice(1); // Remove the 02/03 prefix

  const { address } = bitcoin.payments.p2tr({
    internalPubkey: Buffer.from(xOnlyPubkey),
    network: testnet4
  });
  return address;
}

function getSecretKeyBytes(hexKey) {
  return new Uint8Array(hexKey.match(/.{2}/g).map(b => parseInt(b, 16)));
}

// ============================================
// Trail Management (Reputation)
// ============================================

function loadTrail() {
  if (existsSync(CONFIG.trailFile)) {
    const trail = JSON.parse(readFileSync(CONFIG.trailFile, 'utf8'));
    // Migrate: add faucet tracking if missing
    if (!trail.faucet) {
      trail.faucet = { recipients: {}, totalPaid: 0 };
    }
    if (!trail.players) {
      trail.players = {}; // pubkey -> { btcAddress, balance, wins, losses }
    }
    return trail;
  }
  return {
    version: 2,
    type: 'escrow_agent',
    name: 'RPS-Agent-001',
    created: Date.now(),
    games: [],
    players: {},  // pubkey -> { btcAddress, balance, wins, losses }
    faucet: {
      recipients: {},  // pubkey -> { amount, timestamp, txid }
      totalPaid: 0
    },
    stats: {
      totalGames: 0,
      totalVolume: 0,
      disputes: 0
    }
  };
}

function saveTrail(trail) {
  writeFileSync(CONFIG.trailFile, JSON.stringify(trail, null, 2));
}

function recordGame(trail, game) {
  trail.games.push({
    id: game.id,
    players: game.players,
    stake: game.stake,
    winner: game.winner,
    timestamp: Date.now(),
    commits: game.commits,
    reveals: game.reveals
  });
  trail.stats.totalGames++;
  trail.stats.totalVolume += game.stake * 2;
  saveTrail(trail);
  console.log(`Recorded game ${game.id} - Winner: ${game.winner.slice(0, 8)}...`);
}

function registerPlayer(trail, pubkey, btcAddress) {
  if (!trail.players[pubkey]) {
    trail.players[pubkey] = {
      btcAddress,
      balance: 0,
      wins: 0,
      losses: 0,
      registered: Date.now()
    };
  } else {
    trail.players[pubkey].btcAddress = btcAddress;
  }
  saveTrail(trail);
  console.log(`Registered player ${pubkey.slice(0, 8)}... with address ${btcAddress.slice(0, 12)}...`);
}

async function processFaucetRequest(trail, keyData, pubkey, btcAddress) {
  // Check if already received faucet
  if (trail.faucet.recipients[pubkey]) {
    console.log(`Faucet denied for ${pubkey.slice(0, 8)}... - already received`);
    return { success: false, reason: 'already_received' };
  }

  // Register player
  registerPlayer(trail, pubkey, btcAddress);

  // Send faucet funds
  try {
    const txid = await payWinner(keyData, btcAddress, CONFIG.faucetAmount);
    if (txid) {
      trail.faucet.recipients[pubkey] = {
        amount: CONFIG.faucetAmount,
        timestamp: Date.now(),
        txid,
        btcAddress
      };
      trail.faucet.totalPaid += CONFIG.faucetAmount;
      saveTrail(trail);
      console.log(`Faucet sent ${CONFIG.faucetAmount} sats to ${pubkey.slice(0, 8)}...`);
      return { success: true, txid, amount: CONFIG.faucetAmount };
    }
  } catch (e) {
    console.log(`Faucet payment failed: ${e.message}`);
    return { success: false, reason: e.message };
  }
  return { success: false, reason: 'unknown' };
}

// ============================================
// Game Logic
// ============================================

const BEATS = { rock: 'scissors', paper: 'rock', scissors: 'paper' };

function determineWinner(moveA, moveB) {
  if (moveA === moveB) return 'draw';
  if (BEATS[moveA] === moveB) return 'A';
  return 'B';
}

function verifyCommit(move, salt, commitHash) {
  const expected = sha256(move + ':' + salt);
  return expected === commitHash;
}

// ============================================
// Game State Tracking
// ============================================

const activeGames = new Map();

async function handleGameEvent(event, agentPubkey, trail, keyData) {
  try {
    const data = JSON.parse(event.content);

    // Handle faucet requests (no game ID needed)
    if (data.type === 'faucet_request' && data.btcAddress) {
      const result = await processFaucetRequest(trail, keyData, event.pubkey, data.btcAddress);
      return {
        type: 'faucet_response',
        recipient: event.pubkey,
        ...result
      };
    }

    // Handle player registration
    if (data.type === 'register' && data.btcAddress) {
      registerPlayer(trail, event.pubkey, data.btcAddress);
      return {
        type: 'register_response',
        player: event.pubkey,
        success: true
      };
    }

    // Handle balance query
    if (data.type === 'balance_query') {
      const player = trail.players[event.pubkey];
      return {
        type: 'balance_response',
        recipient: event.pubkey,
        balance: player ? player.balance : 0,
        wins: player ? player.wins : 0,
        losses: player ? player.losses : 0
      };
    }

    // Handle withdraw request
    if (data.type === 'withdraw' && data.amount) {
      const player = trail.players[event.pubkey];
      if (!player) {
        return { type: 'withdraw_response', recipient: event.pubkey, success: false, reason: 'not_registered' };
      }
      if (player.balance < data.amount) {
        return { type: 'withdraw_response', recipient: event.pubkey, success: false, reason: 'insufficient_balance', balance: player.balance };
      }
      if (data.amount < 1000) {
        return { type: 'withdraw_response', recipient: event.pubkey, success: false, reason: 'minimum_1000_sats' };
      }

      try {
        const txid = await payWinner(keyData, player.btcAddress, data.amount);
        player.balance -= data.amount;
        saveTrail(trail);
        console.log(`Withdraw ${data.amount} sats to ${event.pubkey.slice(0, 8)}...: ${txid}`);
        return { type: 'withdraw_response', recipient: event.pubkey, success: true, txid, amount: data.amount, newBalance: player.balance };
      } catch (e) {
        return { type: 'withdraw_response', recipient: event.pubkey, success: false, reason: e.message };
      }
    }

    const gameTag = event.tags.find(t => t[0] === 'g');
    const gameId = gameTag ? gameTag[1] : null;

    if (!gameId) return;

    // Initialize game state if new
    if (!activeGames.has(gameId)) {
      activeGames.set(gameId, {
        id: gameId,
        players: [],
        commits: {},
        reveals: {},
        stake: 0,
        status: 'pending'
      });
    }

    const game = activeGames.get(gameId);

    // Handle escrow request
    if (data.type === 'escrow_request') {
      console.log(`Escrow request for game ${gameId}`);
      game.players = data.players;
      game.stake = data.stake || 1000;
      game.status = 'escrowed';
      return { type: 'escrow_accepted', gameId, agent: agentPubkey };
    }

    // Handle commits
    if (data.type === 'commit') {
      game.commits[event.pubkey] = data.hash;
      console.log(`Commit from ${event.pubkey.slice(0, 8)}... for game ${gameId}`);
    }

    // Handle reveals
    if (data.type === 'reveal') {
      const commitHash = game.commits[event.pubkey];
      if (!commitHash) {
        console.log(`No commit found for ${event.pubkey.slice(0, 8)}...`);
        return;
      }

      if (!verifyCommit(data.move, data.salt, commitHash)) {
        console.log(`Invalid reveal from ${event.pubkey.slice(0, 8)}... - hash mismatch!`);
        return;
      }

      game.reveals[event.pubkey] = { move: data.move, salt: data.salt };
      console.log(`Valid reveal from ${event.pubkey.slice(0, 8)}...: ${data.move}`);

      // Check if both revealed
      if (Object.keys(game.reveals).length === 2) {
        return resolveGame(game);
      }
    }
  } catch (e) {
    // Ignore parse errors
  }
  return null;
}

function resolveGame(game) {
  const players = Object.keys(game.reveals);
  const [playerA, playerB] = players;
  const moveA = game.reveals[playerA].move;
  const moveB = game.reveals[playerB].move;

  const result = determineWinner(moveA, moveB);

  let winner;
  if (result === 'draw') {
    winner = 'draw';
    console.log(`Game ${game.id} is a DRAW`);
  } else if (result === 'A') {
    winner = playerA;
    console.log(`Game ${game.id} - Winner: ${playerA.slice(0, 8)}... (${moveA} beats ${moveB})`);
  } else {
    winner = playerB;
    console.log(`Game ${game.id} - Winner: ${playerB.slice(0, 8)}... (${moveB} beats ${moveA})`);
  }

  game.winner = winner;
  game.status = 'resolved';

  return {
    type: 'game_resolved',
    gameId: game.id,
    players: { [playerA]: moveA, [playerB]: moveB },
    winner,
    result
  };
}

// ============================================
// Nostr Connection
// ============================================

async function startAgent() {
  const keyData = loadOrCreateKey();
  const trail = loadTrail();
  const secretKey = getSecretKeyBytes(keyData.secretKey);

  console.log('');
  console.log('='.repeat(60));
  console.log('RPS ESCROW AGENT');
  console.log('='.repeat(60));
  console.log(`Nostr:  ${keyData.pubkey}`);
  console.log(`BTC:    ${keyData.btcAddress}`);
  console.log(`Games:  ${trail.stats.totalGames} | Volume: ${trail.stats.totalVolume} sats`);
  console.log('='.repeat(60));
  console.log('');

  // Connect to relay
  console.log(`Connecting to ${CONFIG.relay}...`);
  const relay = await Relay.connect(CONFIG.relay);
  console.log('Connected!');
  console.log('Watching for RPS games...');
  console.log('');

  // Publish agent announcement
  const announcement = finalizeEvent({
    kind: 30336,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['d', keyData.pubkey],
      ['t', 'rps-agent'],
      ['name', trail.name],
      ['games', String(trail.stats.totalGames)],
      ['volume', String(trail.stats.totalVolume)]
    ],
    content: JSON.stringify({
      type: 'agent_online',
      name: trail.name,
      stats: trail.stats,
      fee: CONFIG.fee
    })
  }, secretKey);

  await relay.publish(announcement);
  console.log('Published agent announcement');

  // Subscribe to RPS events and faucet requests
  relay.subscribe([
    { kinds: [30334, 30335], '#t': ['rps', 'rps-move', 'rps-escrow', 'rps-faucet', 'rps-register'] }
  ], {
    async onevent(event) {
      const response = await handleGameEvent(event, keyData.pubkey, trail, keyData);

      if (response) {
        // Build tags based on response type
        const tags = [['t', 'rps-agent-response']];
        if (response.gameId) {
          tags.unshift(['g', response.gameId]);
        }
        if (response.recipient) {
          tags.push(['p', response.recipient]);
        }

        // Publish response (with retry on rate-limit)
        const responseEvent = finalizeEvent({
          kind: 30337,
          created_at: Math.floor(Date.now() / 1000),
          tags,
          content: JSON.stringify(response)
        }, secretKey);

        try {
          await relay.publish(responseEvent);
          console.log(`Published: ${response.type}`);
        } catch (e) {
          console.log(`Failed to publish ${response.type}: ${e.message}`);
          // Retry after delay if rate-limited
          if (e.message.includes('rate-limit')) {
            console.log('Rate-limited, retrying in 5s...');
            setTimeout(async () => {
              try {
                await relay.publish(responseEvent);
                console.log(`Retry published: ${response.type}`);
              } catch (e2) {
                console.log(`Retry failed: ${e2.message}`);
              }
            }, 5000);
          }
        }

        // Record completed games and settle balances
        if (response.type === 'game_resolved') {
          const game = activeGames.get(response.gameId);
          recordGame(trail, game);

          const players = Object.keys(game.reveals);
          const [playerA, playerB] = players;

          if (response.winner === 'draw') {
            // Draw - no balance changes
            console.log('Draw - no balance changes');
          } else {
            // Winner takes loser's stake
            const winner = response.winner;
            const loser = players.find(p => p !== winner);

            if (trail.players[winner] && trail.players[loser]) {
              // Transfer stake from loser to winner
              trail.players[winner].balance += CONFIG.stakeAmount;
              trail.players[winner].wins++;
              trail.players[loser].balance -= CONFIG.stakeAmount;
              trail.players[loser].losses++;
              saveTrail(trail);

              console.log(`${winner.slice(0, 8)}... wins ${CONFIG.stakeAmount} sats from ${loser.slice(0, 8)}...`);
              console.log(`  Winner balance: ${trail.players[winner].balance} sats`);
              console.log(`  Loser balance: ${trail.players[loser].balance} sats`);
            }
          }
        }
      }
    }
  });

  // Keep alive
  console.log('');
  console.log('Agent running. Press Ctrl+C to stop.');
}

// ============================================
// CLI
// ============================================

const args = process.argv.slice(2);

if (args[0] === 'status') {
  const keyData = loadOrCreateKey();
  const trail = loadTrail();

  // Fetch balance
  const balance = await fetchBalance(keyData.btcAddress);

  console.log('');
  console.log('Agent Status:');
  console.log(`  Nostr Pubkey: ${keyData.pubkey}`);
  console.log(`  BTC Address:  ${keyData.btcAddress}`);
  console.log(`  Balance:      ${(balance / 100000000).toFixed(8)} BTC (${balance} sats)`);
  console.log(`  Games: ${trail.stats.totalGames}`);
  console.log(`  Volume: ${trail.stats.totalVolume} sats`);
  console.log(`  Disputes: ${trail.stats.disputes}`);
  console.log('');
  console.log('Recent games:');
  trail.games.slice(-5).forEach(g => {
    console.log(`  ${g.id}: ${g.winner.slice(0, 8)}... won ${g.stake * 2} sats`);
  });
} else if (args[0] === 'pay') {
  // Test payment: node agent.js pay <address> <amount_sats>
  const address = args[1];
  const amount = parseInt(args[2]) || CONFIG.payoutAmount;

  if (!address) {
    console.log('Usage: node agent.js pay <address> [amount_sats]');
    process.exit(1);
  }

  const keyData = loadOrCreateKey();
  try {
    const txid = await payWinner(keyData, address, amount);
    console.log(`\nPayment sent!`);
    console.log(`TXID: ${txid}`);
    console.log(`View: https://mempool.space/testnet4/tx/${txid}`);
  } catch (e) {
    console.error('Payment failed:', e.message);
  }
} else if (args[0] === 'trail') {
  const trail = loadTrail();
  console.log(JSON.stringify(trail, null, 2));
} else {
  startAgent().catch(console.error);
}
