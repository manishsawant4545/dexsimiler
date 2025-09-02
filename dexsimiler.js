import fs from 'fs';
import path from 'path';
import { ethers } from 'ethers';
import axios from 'axios';
import TelegramBot from 'node-telegram-bot-api';
import chalk from 'chalk';
import express from 'express';
import winston from 'winston';
import 'winston-daily-rotate-file';

// ===== Logging setup with daily rotation =====
const transport = new winston.transports.DailyRotateFile({
  filename: 'logs/eth-monitor-%DATE%.log',
  datePattern: 'YYYY-MM-DD',
  maxSize: '20m',
  maxFiles: '14d',
});
export const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => `${timestamp} [${level}]: ${message}`)
  ),
  transports: [transport, new winston.transports.Console()],
});


// === config ===
const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY;
const ALCHEMY_URL = process.env.ALCHEMY_URL;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const MAX_RETRIES = 5;
const INITIAL_DELAY_MS = 10000;
const STATE_FILE = path.resolve('./state.json');


// Initialize Telegram bot
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, {
  polling: true,
  request: {
    agentOptions: {
      keepAlive: true,
      family: 4,
    },
  },
});

// ==== State persistence ====
function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state), 'utf8');
}

function loadState() {
  if (fs.existsSync(STATE_FILE)) {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  }
  return { lastBlock: 0 };
}

let { lastBlock } = loadState();

// ==== Logger helper to replace console ====
const log = {
  info: (msg) => logger.info(msg),
  warn: (msg) => logger.warn(msg),
  error: (msg) => logger.error(msg),
};

// ==== Retry with exponential backoff ====
async function retryWithBackoff(fn, attempts = MAX_RETRIES, delay = INITIAL_DELAY_MS) {
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (error) {
      if (i === attempts - 1) throw error;
      log.warn(`Attempt ${i + 1} failed for ${context}: ${error.message}. Retrying in ${delay}ms...`);
      await new Promise((r) => setTimeout(r, delay));
      delay *= 2;
    }
  }
}

// ==== Circuit Breaker Implementation ====
class CircuitBreaker {
  constructor(maxFailures = 5, cooldownMs = 60000) {
    this.maxFailures = maxFailures;
    this.cooldownMs = cooldownMs;
    this.failures = 0;
    this.circuitOpen = false;
    this.lastFailureTime = null;
  }

  async call(fn) {
    if (this.circuitOpen) {
      const elapsed = Date.now() - this.lastFailureTime;
      if (elapsed > this.cooldownMs) {
        try {
          const result = await fn();
          this.reset();
          return result;
        } catch (err) {
          this.lastFailureTime = Date.now();
          throw err;
        }
      } else {
        throw new Error('Circuit breaker is open, skipping request');
      }
    }

    try {
      const result = await fn();
      this.reset();
      return result;
    } catch (err) {
      this.failures++;
      this.lastFailureTime = Date.now();
      if (this.failures >= this.maxFailures) {
        this.circuitOpen = true;
        log.error('Circuit breaker opened due to repeated failures');
      }
      throw err;
    }
  }

  reset() {
    this.failures = 0;
    this.circuitOpen = false;
    this.lastFailureTime = null;
  }
}

const breaker = new CircuitBreaker();

// Minimal HTTP Server
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.send('Ethereum Monitor is running');
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});

// DEXTools Token Creator comment block to detect
const DEXTOOLS_COMMENT_BLOCK = `/**
 *  ____  _______  _______           _     
 * |  _ \\| ____\\ \\/ /_   _|__   ___ | |___ 
 * | | | |  _|  \\  /  | |/ _ \\ / _ \\| / __|
 * | |_| | |___ /  \\  | | (_) | (_) | __ \\
 * |____/|_____/\\/_\\ |_|___/ ___/|_|___/
 *
 * This smart contract was created effortlessly using the DEXTools Token Creator.
 * 
 * 🌐 Website: [https://www.dextools.io/](https://www.dextools.io/)
 * 🐦 Twitter: [https://twitter.com/DEXToolsApp](https://twitter.com/DEXToolsApp)
 * 💬 Telegram: [https://t.me/DEXToolsCommunity](https://t.me/DEXToolsCommunity)
 * 
 * 🚀 Unleash the power of decentralized finances and tokenization with DEXTools Token Creator. Customize your token seamlessly. Manage your created tokens conveniently from your user panel - start creating your dream token today!
 */`;

// Send Telegram alert
function sendTelegramAlert(address, matchType, snippet = '') {
  let msg = '';
  if (matchType === 'dextools-comment') {
    msg = `DEXTools Token Creator detected!\n\nContract: ${address}\nThe contract source contains the DEXTools Token Creator comment block.\nCheck on Etherscan: https://etherscan.io/address/${address}`;
  }
  if (snippet) {
    msg += `\n\nSnippet:\n${snippet}`;
  }
  bot.sendMessage(TELEGRAM_CHAT_ID, msg)
    .then(() => console.log(chalk.green('Telegram alert sent!')))
    .catch((err) => console.error('Telegram error:', err.message));
}


function extractSourcesFromJSON(sourceCode) {
  try {
    const parsed = JSON.parse(sourceCode);
    if (parsed.sources) {
      return Object.values(parsed.sources)
        .map(obj => obj.content)
        .filter(Boolean)
        .join('\n\n');
    }
    return sourceCode;
  } catch (error) {
    return sourceCode; // Not JSON, return as is
  }
}

async function robustFetchVerifiedSource(address, apiKey) {
  const url = `https://api.etherscan.io/api?module=contract&action=getsourcecode&address=${address}&chainId=1&apikey=${apiKey}`;

  return breaker.call(() =>
    retryWithBackoff(async () => {
      const res = await axios.get(url);
      log.info(`Etherscan API for ${address}: status=${res.status}, message=${res.data.message}`);
      if (res.data.status === '1' && res.data.result && res.data.result[0]) {
        let sourceCode = res.data.result[0].SourceCode;
        if (sourceCode && sourceCode.trim().length > 0) {
          if (sourceCode.trim().startsWith('{')) {
            sourceCode = extractSourcesFromJSON(sourceCode.trim());
          }
          return sourceCode;
        }
      }
      throw new Error('Source code not available or empty');
    })
  );
}

// ==== Telegram polling error handlers with reconnect logic ===============
let reconnectDelay = 5000;
const MAX_RECONNECT_DELAY = 60000;

bot.on('polling_error', async (error) => {
  log.error(`Polling error: ${error.code} - ${error.message}`);

  try {
    await bot.stopPolling();
  } catch (e) {
    log.error('Error stopping polling: ' + e.message);
  }

  if (error.code === 'ETELEGRAM' && error.message.includes('409 Conflict')) {
    log.error('Conflict detected: Another bot instance is running. Exiting process.');
    process.exit(1);
  }

  if (error.code === 'EFATAL') {
    log.error('Fatal polling error detected, attempting reconnect...');
    await new Promise((resolve) => setTimeout(resolve, 5000));
    try {
      await bot.startPolling();
      log.info('Polling restarted successfully');
      reconnectDelay = 5000;
    } catch (reconnectErr) {
      log.error('Failed to restart polling: ' + reconnectErr.message);
      process.exit(1);
    }
    return;
  }

  logger.info(`Reconnecting polling in ${reconnectDelay / 1000} seconds...`);
  await new Promise((resolve) => setTimeout(resolve, reconnectDelay));

  try {
    await bot.startPolling();
    log.info('Polling restarted successfully');
    reconnectDelay = 5000;
  } catch (err) {
    log.error('Reconnect failed: ' + err.message);
    reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
  }
});


async function monitorBlocks() {
  const provider = new ethers.JsonRpcProvider(ALCHEMY_URL);

  log.info('Monitoring Ethereum for new contract deployments...');

  provider.on('block', async (blockNumber) => {
    if (blockNumber <= lastBlock) return;
    lastBlock = blockNumber;
    saveState({ lastBlock });

    log.info(chalk.yellow(`Checking block #${blockNumber}`));

    try {
      const block = await provider.getBlock(blockNumber, true);
      const transactions = block.prefetchedTransactions;

      if (!Array.isArray(transactions) || transactions.length === 0) {
        log.warn('No transactions fetched for this block (prefetchedTransactions empty)');
        return;
      }

      for (const tx of transactions) {
        if (!tx.to) {
          const receipt = await provider.getTransactionReceipt(tx.hash);
          const contractAddress = receipt.contractAddress;
          log.info(chalk.cyan(`New contract deployed at: ${contractAddress}`));

          try {
            const source = await robustFetchVerifiedSource(contractAddress, ETHERSCAN_API_KEY);
            if (source) {
              if (source.includes(DEXTOOLS_COMMENT_BLOCK)) {
                log.info(chalk.green(`DEXTools comment detected! Alerting Telegram.`));
                let snippetStart = source.indexOf(DEXTOOLS_COMMENT_BLOCK);
                let snippet = source.substring(snippetStart, snippetStart + 300);
                sendTelegramAlert(contractAddress, 'dextools-comment', snippet);
              } else {
                log.info(`DEXTOOLS comment block not found.`);
              }
            }
          } catch (sourceErr) {
            // Check if error is due to no source after retries
            if (sourceErr.message === 'Source code not available or empty') {
              log.error(chalk.red(`No verified source available for contract ${contractAddress} after ${MAX_RETRIES} attempts.`));
            } else {
              log.error('Error fetching or processing source code for contract ${contractAddress}: ' + sourceErr.message);
            }
          }
        }
      }
    } catch (err) {
      log.error('Error in processing contract deployment: ' + err.message);
    }
  });
}


monitorBlocks();
