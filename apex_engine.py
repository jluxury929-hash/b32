import os
import asyncio
import re
import json
import pickle
import math
import random
from web3 import Web3
from decimal import Decimal
from dotenv import load_dotenv
from telethon import TelegramClient, events
from textblob import TextBlob
from colorama import Fore, Style, init

init(autoreset=True)
load_dotenv()

# ==========================================
# 1. GLOBAL CONFIGURATION
# ==========================================
PRIVATE_KEY = os.getenv("PRIVATE_KEY")
RPC_URL = "https://arb1.arbitrum.io/rpc"
APEX_CONTRACT = "0xYOUR_DEPLOYED_CONTRACT_ADDRESS" # <--- PASTE CONTRACT ADDRESS HERE

# RELIABLE SIGNAL SOURCES (High Volatility)
SOURCES = {
"FAT_PIG": {"id": 10012345678, "default_trust": 0.95},
"BINANCE_KILLERS": {"id": 10087654321, "default_trust": 0.90}
}

# ARBITRUM INFRASTRUCTURE
WETH = "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1"
USDC = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831"
SUSHI_ROUTER = "0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506"

# CONNECT
w3 = Web3(Web3.HTTPProvider(RPC_URL))
account = w3.eth.account.from_key(PRIVATE_KEY)
MY_ADDR = account.address

# ==========================================
# 2. AI & TRUST ENGINE
# ==========================================
class AIEngine:
def __init__(self):
self.trust_file = "trust_scores.pkl"
self.trust_scores = self.load_trust()

def load_trust(self):
if os.path.exists(self.trust_file):
with open(self.trust_file, 'rb') as f: return pickle.load(f)
return {k: v['default_trust'] for k, v in SOURCES.items()}

def update_trust(self, source_name, success):
current = self.trust_scores.get(source_name, 0.5)
new_score = min(0.99, current * 1.05) if success else max(0.1, current * 0.90)
self.trust_scores[source_name] = new_score
with open(self.trust_file, 'wb') as f: pickle.dump(self.trust_scores, f)

def analyze_sentiment(self, text):
clean = text.upper()
if any(x in clean for x in ["SCAM", "RUG", "SELL", "DUMP"]): return 0.0
blob = TextBlob(text)
return (blob.sentiment.polarity + 1) / 2

ai = AIEngine()

# ==========================================
# 3. FILTERS (Value & Health)
# ==========================================
async def get_amount_out(router, t_in, t_out, amt):
abi = '[{"inputs":[{"internalType":"uint256","name":"amountIn","type":"uint256"},{"internalType":"address[]","name":"path","type":"address[]"}],"name":"getAmountsOut","outputs":[{"internalType":"uint256[]","name":"amounts","type":"uint256[]"}],"stateMutability":"view","type":"function"}]'
contract = w3.eth.contract(address=router, abi=abi)
try:
loop = asyncio.get_event_loop()
res = await loop.run_in_executor(None, lambda: contract.functions.getAmountsOut(int(amt), [t_in, t_out]).call())
return res[1]
except: return 0

async def check_filters(token_addr):
"""
1. Checks if Pool is Healthy (Liquidity Exists).
2. Checks if Token is Low Value (Cheap).
"""
try:
one_eth = w3.to_wei(1, 'ether')

# Test Swap Simulation
tokens_received = await get_amount_out(SUSHI_ROUTER, WETH, token_addr, one_eth)

if tokens_received == 0:
print(f"{Fore.RED} ⚠️ Pool Dead/Empty (Liquidity Too Low).")
return False

# Low Value Check: 1 ETH should buy > 100,000 tokens
if tokens_received < (100000 * 10**18):
print(f"{Fore.YELLOW} 🚫 Token too expensive (High Value). Skipping.")
return False

print(f"{Fore.CYAN} 💎 Low Value Gem Verified! (1 ETH = {tokens_received // 10**18} Tokens)")
return True
except: return False

# ==========================================
# 4. TRIANGULAR ARBITRAGE SCANNER
# ==========================================
async def find_opportunity(token_addr):
"""
Checks loop: ETH -> Token -> USDC -> ETH
"""
# TRADE SIZING: Use 10% of Wallet Balance
balance = w3.eth.get_balance(MY_ADDR)
trade_size = int(balance * 0.10)

if trade_size < w3.to_wei(0.01, 'ether'):
print(f"{Fore.YELLOW} ⚠️ Balance too low to trade.")
return None

print(f"{Fore.CYAN} 🔬 Scanning with {w3.from_wei(trade_size, 'ether')} ETH...")

# Step 1: ETH -> Token
s1 = await get_amount_out(SUSHI_ROUTER, WETH, token_addr, trade_size)
if s1 == 0: return None

# Step 2: Token -> USDC
s2 = await get_amount_out(SUSHI_ROUTER, token_addr, USDC, s1)
if s2 == 0: return None

# Step 3: USDC -> ETH
s3 = await get_amount_out(SUSHI_ROUTER, USDC, WETH, s2)

# Profit Check
profit_wei = s3 - trade_size
min_profit = w3.to_wei(0.002, 'ether') # Cover Gas

if profit_wei > min_profit:
return {
"profit": w3.from_wei(profit_wei, 'ether'),
"size": trade_size,
"roi": profit_wei / trade_size
}
return None

# ==========================================
# 5. EXECUTION
# ==========================================
async def execute_apex(strat, token_addr, source_name):
print(f"{Fore.GREEN} ⚡ PROFITABLE LOOP! Est Profit: {strat['profit']} ETH")
print(f"{Fore.MAGENTA} 🚀 EXECUTING ATOMIC TRADE...")

contract = w3.eth.contract(address=APEX_CONTRACT, abi='[{"inputs":[{"internalType":"address","name":"router","type":"address"},{"internalType":"address","name":"tokenA","type":"address"},{"internalType":"address","name":"tokenB","type":"address"},{"internalType":"uint256","name":"amountIn","type":"uint256"}],"name":"executeTriangular","outputs":[],"stateMutability":"nonpayable","type":"function"}]')

bribe = int(w3.eth.gas_price * 1.5)

tx = contract.functions.executeTriangular(
SUSHI_ROUTER,
token_addr,
USDC,
strat['size']
).build_transaction({
'from': MY_ADDR,
'gas': 600000,
'maxFeePerGas': bribe,
'maxPriorityFeePerGas': w3.to_wei(2, 'gwei'),
'nonce': w3.eth.get_transaction_count(MY_ADDR),
'chainId': 42161
})

signed = w3.eth.account.sign_transaction(tx, PRIVATE_KEY)

try:
tx_hash = w3.eth.send_raw_transaction(signed.rawTransaction)
print(f"{Fore.GREEN} ✅ TX SENT: {w3.to_hex(tx_hash)}")

await asyncio.sleep(2)
receipt = w3.eth.get_transaction_receipt(tx_hash)

if receipt.status == 1:
print(f"{Fore.GREEN} 💰 SUCCESS.")
ai.update_trust(source_name, True)
else:
print(f"{Fore.RED} ❌ REVERTED (Capital Safe).")
ai.update_trust(source_name, False)

except Exception as e:
print(f"{Fore.RED} ❌ Error: {e}")

# ==========================================
# 6. MAIN LOOP
# ==========================================
async def main():
print(f"{Fore.WHITE}🦁 APEX ENGINE ONLINE | No Flash Loans | High Volatility")

TG_ID = os.getenv("TG_API_ID")
TG_HASH = os.getenv("TG_API_HASH")

if TG_ID:
client = TelegramClient('apex_session', TG_ID, TG_HASH)
@client.on(events.NewMessage)
async def handler(event):
# 1. IDENTIFY SOURCE
source = "UNKNOWN"
for name, data in SOURCES.items():
if event.chat_id == data['id']: source = name

if source != "UNKNOWN" and "$" in event.raw_text:
# 2. AI CHECK
sentiment = ai.analyze_sentiment(event.raw_text)
trust = ai.trust_scores.get(source, 0.5)

if (sentiment * trust) > 0.6:
try:
ticker = event.raw_text.split("$")[1].split(" ")[0].upper()
# Resolve Mock Address (In prod use a Token List)
if ticker == "PEPE":
addr = "0x25d887Ce7a35172C62FeBFD67a1856F20FaEbb00"

# 3. RUN FILTERS
if await check_filters(addr):
# 4. FIND & EXECUTE
strat = await find_opportunity(addr)
if strat: await execute_apex(strat, addr, source)
except: pass
await client.start()
await client.run_until_disconnected()
else:
print(" ⚠️ Simulation Mode.")
while True:
await asyncio.sleep(5)
# Simulating PEPE
addr = "0x25d887Ce7a35172C62FeBFD67a1856F20FaEbb00"
if await check_filters(addr):
strat = await find_opportunity(addr)
if strat: await execute_apex(strat, addr, "SIM")

if __name__ == "__main__":
loop = asyncio.new_event_loop()
asyncio.set_event_loop(loop)
try:
loop.run_until_complete(main())
except KeyboardInterrupt:
print("Stopped.")
