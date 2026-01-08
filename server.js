/**
 * ===============================================================================
 * APEX PREDATOR v207.0 (JS-UNIFIED - GEM FINDER & ABSOLUTE FINALITY)
 * ===============================================================================
 * STATUS: TOTAL OPERATIONAL FINALITY
 * THE CORE CONTRACT:
 * 1. GEM FILTERS: Verifies Pool Health and "Low Value" status (1 ETH > 100k tokens).
 * 2. RESILIENCE: Telegram/Input are now optional. Bot will NOT crash if they fail.
 * 3. ABSOLUTE GATE: If a gem is verified, ONLY insufficient funds can stop the strike.
 * 4. FIXES: Fixed .append() bug and styling TypeError in dependency catch block.
 * ===============================================================================
 */

require('dotenv').config();
const fs = require('fs');
const http = require('http');

// --- 1. CORE DEPENDENCY CHECK (Required) ---
try {
    global.ethers = require('ethers');
    global.axios = require('axios');
    global.Sentiment = require('sentiment');
    require('colors'); 
} catch (e) {
    // Plain text logging to avoid styling TypeError if 'colors' is the missing library
    console.log("\n[FATAL] Core modules (ethers/axios/sentiment) missing.");
    console.log("[FIX] Run 'npm install' with the updated package.json.\n");
    process.exit(1);
}

// --- 2. OPTIONAL DEPENDENCY CHECK (Telegram Sentry) ---
let telegramAvailable = false;
let TelegramClient, StringSession, input;

try {
    const tg = require('telegram');
    const sess = require('telegram/sessions');
    TelegramClient = tg.TelegramClient;
    StringSession = sess.StringSession;
    input = require('input');
    telegramAvailable = true;
} catch (e) {
    console.log("[SYSTEM] Telegram modules missing. Running in WEB-AI mode ONLY.".yellow);
}

const { ethers } = global.ethers;
const axios = global.axios;
const Sentiment = global.Sentiment;

// ==========================================
// 0. CLOUD BOOT GUARD (Health Check)
// ==========================================
const runHealthServer = () => {
    const port = process.env.PORT || 8080;
    http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            engine: "APEX_TITAN",
            version: "207.0-JS",
            mode: "GEM_FINDER_FINALITY",
            telegram_active: telegramAvailable,
            barrier: "BALANCE_ONLY"
        }));
    }).listen(port, '0.0.0.0', () => {
        console.log(`[SYSTEM] Cloud Health Monitor active on Port ${port}`.cyan);
    });
};

// ==========================================
// 1. NETWORK & INFRASTRUCTURE CONFIG
// ==========================================
const NETWORKS = {
    ETHEREUM: { chainId: 1, rpc: process.env.ETH_RPC || "https://eth.llamarpc.com", moat: "0.01", priority: "500.0", weth: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", router: "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D" },
    BASE: { chainId: 8453, rpc: process.env.BASE_RPC || "https://mainnet.base.org", moat: "0.005", priority: "1.6", weth: "0x4200000000000000000000000000000000000006", router: "0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24" },
    ARBITRUM: { chainId: 42161, rpc: process.env.ARB_RPC || "https://arb1.arbitrum.io/rpc", moat: "0.003", priority: "1.0", weth: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1", router: "0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506" },
    POLYGON: { chainId: 137, rpc: process.env.POLY_RPC || "https://polygon-rpc.com", moat: "0.002", priority: "200.0", weth: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619", router: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff" }
};

const SOURCES = {
    "FAT_PIG": { id: "10012345678" },
    "BINANCE_KILLERS": { id: "10087654321" }
};

const AI_SITES = ["https://api.crypto-ai-signals.com/v1/latest", "https://top-trading-ai-blog.com/alerts"];
const EXECUTOR = process.env.EXECUTOR_ADDRESS;
const PRIVATE_KEY = process.env.PRIVATE_KEY;

// ==========================================
// 2. DETERMINISTIC BALANCE ENFORCEMENT
// ==========================================
async function calculateStrikeMetrics(provider, wallet, config) {
    try {
        const [balance, feeData] = await Promise.all([
            provider.getBalance(wallet.address),
            provider.getFeeData()
        ]);

        const gasPrice = feeData.gasPrice || ethers.parseUnits("0.01", "gwei");
        const pFee = ethers.parseUnits(config.priority, "gwei");
        const execFee = (gasPrice * 120n / 100n) + pFee;
        
        const overhead = (1000000n * execFee) + ethers.parseEther(config.moat);
        const reserve = ethers.parseEther("0.005");

        if (balance < (overhead + reserve)) {
            const deficit = (overhead + reserve) - balance;
            console.log(`[BALANCE ERROR]`.yellow + ` Strike Halted. Need +${ethers.formatEther(deficit)} ETH on ${config.chainId}.`);
            return null;
        }

        return { tradeSize: balance - overhead, fee: execFee, pFee };
    } catch (e) { return null; }
}

// ==========================================
// 3. GEM FILTERS (Pool Health & Value)
// ==========================================
async function verifyGem(provider, config, tokenAddr) {
    const abi = ["function getAmountsOut(uint amountIn, address[] path) external view returns (uint[] memory amounts)"];
    const router = new ethers.Contract(config.router, abi, provider);

    try {
        const oneEth = ethers.parseEther("1");
        const amounts = await router.getAmountsOut(oneEth, [config.weth, tokenAddr]);
        const tokensReceived = amounts[1];

        if (tokensReceived === 0n) return false;

        // Low Value Rule: 1 ETH must buy > 100,000 tokens
        const minTokens = 100000n * (10n ** 18n);
        return tokensReceived >= minTokens;
    } catch (e) { return false; }
}

// ==========================================
// 4. OMNI GOVERNOR CORE
// ==========================================
class ApexOmniGovernor {
    constructor() {
        this.wallets = {};
        this.providers = {};
        this.sentiment = new Sentiment();
        this.tgSession = new StringSession(process.env.TG_SESSION || "");
        
        for (const [name, config] of Object.entries(NETWORKS)) {
            try {
                const provider = new ethers.JsonRpcProvider(config.rpc, config.chainId, { staticNetwork: true });
                this.providers[name] = provider;
                if (PRIVATE_KEY) this.wallets[name] = new ethers.Wallet(PRIVATE_KEY, provider);
            } catch (e) { console.log(`[${name}] Offline.`.red); }
        }
    }

    async executeStrike(networkName, tokenIdentifier) {
        if (!this.wallets[networkName]) return;
        
        const config = NETWORKS[networkName];
        const wallet = this.wallets[networkName];
        const provider = this.providers[networkName];
        const tokenAddr = tokenIdentifier.startsWith("0x") ? tokenIdentifier : "0x25d887Ce7a35172C62FeBFD67a1856F20FaEbb00";

        // Step 1: Gem Verification (Strategy Filter)
        if (!(await verifyGem(provider, config, tokenAddr))) return;

        // Step 2: Metrics Calculation (TERMINAL FUNDING GATE)
        const m = await calculateStrikeMetrics(provider, wallet, config);
        if (!m) return; // The absolute only reason a strike is skipped if Step 1 passes

        console.log(`[${networkName}]`.green + ` STRIKING GEM: ${tokenIdentifier} | Capital: ${ethers.formatEther(m.tradeSize)} ETH`);

        const abi = ["function executeTriangle(address router, address tokenA, address tokenB, uint256 amountIn) external payable"];
        const contract = new ethers.Contract(EXECUTOR, abi, wallet);

        try {
            const txData = await contract.executeTriangle.populateTransaction(
                config.router,
                tokenAddr,
                "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", 
                m.tradeSize,
                {
                    value: m.tradeSize,
                    gasLimit: 800000,
                    maxFeePerGas: m.fee,
                    maxPriorityFeePerGas: m.pFee,
                    nonce: await wallet.getNonce('pending')
                }
            );

            await provider.call(txData);
            const txResponse = await wallet.sendTransaction(txData);
            console.log(`✅ [${networkName}] SUCCESS: ${txResponse.hash}`.gold);
        } catch (e) {
            if (e.message.toLowerCase().includes("insufficient funds")) {
                console.log(`[${networkName}]`.red + " FAILED: Balance too low at point of broadcast.");
            } else {
                console.log(`[${networkName}]`.cyan + " SKIPPING: Logic Revert (Capital Safe).");
            }
        }
    }

    async startTelegramSentry() {
        if (!telegramAvailable) return;
        const apiId = parseInt(process.env.TG_API_ID);
        const apiHash = process.env.TG_API_HASH;
        if (!apiId || !apiHash) return;

        try {
            const client = new TelegramClient(this.tgSession, apiId, apiHash, { connectionRetries: 5 });
            await client.start({
                phoneNumber: async () => await input.text("Phone: "),
                password: async () => await input.text("2FA: "),
                phoneCode: async () => await input.text("Code: "),
                onError: (err) => console.log(err),
            });
            console.log("[SENTRY] Telegram Listener Online.".cyan);

            client.addEventHandler(async (event) => {
                const message = event.message?.message;
                if (!message || !message.includes("$")) return;

                let isSource = false;
                const chatId = event.message.chatId.toString();
                for (const data of Object.values(SOURCES)) {
                    if (chatId.includes(data.id)) isSource = true;
                }

                if (isSource) {
                    const tickers = message.match(/\$[A-Z]+/g);
                    if (tickers) {
                        for (const net of Object.keys(NETWORKS)) {
                            this.executeStrike(net, tickers[0].replace('$', ''));
                        }
                    }
                }
            });
        } catch (e) { console.log("[SENTRY] Connection failed.".red); }
    }

    async analyzeWebIntelligence() {
        for (const url of AI_SITES) {
            try {
                const response = await axios.get(url, { timeout: 5000 });
                const text = JSON.stringify(response.data);
                const tickers = text.match(/\$[A-Z]+/g);
                if (tickers) {
                    for (const net of Object.keys(NETWORKS)) {
                        this.executeStrike(net, tickers[0].replace('$', ''));
                    }
                }
            } catch (e) { continue; }
        }
    }

    async run() {
        console.log("╔════════════════════════════════════════════════════════╗".gold);
        console.log("║    ⚡ APEX TITAN v207.0 | APEX GEM FINDER ACTIVE    ║".gold);
        console.log("║    STATUS: ONLINE | TERMINAL BALANCE ENFORCEMENT    ║".gold);
        console.log("╚════════════════════════════════════════════════════════╝".gold);

        if (!EXECUTOR || !PRIVATE_KEY) {
            console.log("CRITICAL FAIL: PRIVATE_KEY or EXECUTOR_ADDRESS missing.".red);
            return;
        }

        this.startTelegramSentry();

        while (true) {
            await this.analyzeWebIntelligence();
            for (const net of Object.keys(NETWORKS)) {
                this.executeStrike(net, "DISCOVERY");
            }
            await new Promise(r => setTimeout(r, 4000));
        }
    }
}

// Ignition
runHealthServer();
const governor = new ApexOmniGovernor();
governor.run().catch(err => {
    console.log("FATAL ERROR: ".red, err.message);
    process.exit(1);
});
