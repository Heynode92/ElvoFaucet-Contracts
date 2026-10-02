import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  Contract,
  JsonRpcProvider,
  Wallet,
  formatEther,
  formatUnits,
  getAddress,
  parseEther,
} from "ethers";
import {
  CHAIN_ID,
  PAYOUT,
  STOCK_TOKENS,
  TREASURY_ADDRESS,
  TUSDG,
} from "./robinhood-testnet-config.mjs";

const STATE_FILE = resolve("deployments/robinhood-testnet.json");
const CONFIRMATION_PHRASE = "ELVO_FAUCET_FUND";

const FAUCET_ABI = [
  "function availableClaims() view returns (uint256)",
  "function NATIVE_PAYOUT() view returns (uint256)",
  "function TUSDG_PAYOUT() view returns (uint256)",
  "function STOCK_PAYOUT() view returns (uint256)",
  "function tUSDG() view returns (address)",
  "function stockTokens() view returns (address[10])",
];

const ERC20_ABI = [
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address to,uint256 amount) returns (bool)",
];

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error("Missing required environment variable: " + name);
  return value;
}

function parseArgs(argv) {
  let claimsRaw;
  let confirm;
  let dryRun = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }

    if (arg.startsWith("--claims=")) {
      claimsRaw = arg.slice("--claims=".length);
      continue;
    }
    if (arg === "--claims") {
      claimsRaw = argv[++index];
      continue;
    }

    if (arg.startsWith("--confirm=")) {
      confirm = arg.slice("--confirm=".length);
      continue;
    }
    if (arg === "--confirm") {
      confirm = argv[++index];
      continue;
    }

    throw new Error("Unknown funding argument: " + arg);
  }

  if (!claimsRaw || !/^[1-9]\d*$/u.test(claimsRaw)) {
    throw new Error("--claims must be a positive whole number");
  }

  const claims = BigInt(claimsRaw);
  if (claims > 1_000_000n) {
    throw new Error("--claims is unexpectedly large; maximum per funding run is 1000000");
  }

  if (!dryRun && confirm !== CONFIRMATION_PHRASE) {
    throw new Error(
      "Refusing funding transfer. Review --dry-run first, then pass --confirm=" +
        CONFIRMATION_PHRASE
    );
  }

  return { claims, dryRun };
}

async function loadDeployment() {
  const state = JSON.parse(await readFile(STATE_FILE, "utf8"));

  if (state.project !== "elvo-faucet") {
    throw new Error("Deployment state project identity mismatch");
  }
  if (BigInt(state.chainId) !== CHAIN_ID) {
    throw new Error("Deployment state chain ID mismatch");
  }
  if (!state.contractAddress) {
    throw new Error("Deployment state is missing contractAddress");
  }

  return state;
}

async function verifyFaucet(provider, address) {
  const code = await provider.getCode(address);
  if (code === "0x") throw new Error("No faucet bytecode at " + address);

  const faucet = new Contract(address, FAUCET_ABI, provider);
  const [
    nativePayout,
    tusdgPayout,
    stockPayout,
    tusdgAddress,
    stockAddresses,
    availableClaims,
  ] = await Promise.all([
    faucet.NATIVE_PAYOUT(),
    faucet.TUSDG_PAYOUT(),
    faucet.STOCK_PAYOUT(),
    faucet.tUSDG(),
    faucet.stockTokens(),
    faucet.availableClaims(),
  ]);

  if (nativePayout !== parseEther(PAYOUT.nativeEth)) {
    throw new Error("Faucet native payout does not match repository configuration");
  }
  if (tusdgPayout !== parseEther(PAYOUT.tUSDG)) {
    throw new Error("Faucet tUSDG payout does not match repository configuration");
  }
  if (stockPayout !== parseEther(PAYOUT.stockEach)) {
    throw new Error("Faucet stock payout does not match repository configuration");
  }
  if (getAddress(tusdgAddress) !== getAddress(TUSDG.address)) {
    throw new Error("Faucet tUSDG address mismatch");
  }

  for (let index = 0; index < STOCK_TOKENS.length; index += 1) {
    if (getAddress(stockAddresses[index]) !== getAddress(STOCK_TOKENS[index].address)) {
      throw new Error("Faucet stock address mismatch for " + STOCK_TOKENS[index].symbol);
    }
  }

  return { faucet, availableClaims };
}

async function inspectToken(wallet, asset, recipient, amount) {
  const address = getAddress(asset.address);
  const code = await wallet.provider.getCode(address);
  if (code === "0x") throw new Error(asset.symbol + ": token bytecode is missing");

  const token = new Contract(address, ERC20_ABI, wallet);
  const [symbol, decimals, treasuryBalance, faucetBalance] = await Promise.all([
    token.symbol(),
    token.decimals(),
    token.balanceOf(wallet.address),
    token.balanceOf(recipient),
  ]);

  if (symbol !== asset.symbol) {
    throw new Error(asset.symbol + ": on-chain symbol mismatch (" + symbol + ")");
  }
  if (decimals !== 18n) {
    throw new Error(asset.symbol + ": expected 18 decimals");
  }
  if (treasuryBalance < amount) {
    throw new Error(
      asset.symbol +
        ": treasury has " +
        formatUnits(treasuryBalance, 18) +
        ", requires " +
        formatUnits(amount, 18)
    );
  }

  const staticResult = await token.transfer.staticCall(recipient, amount);
  if (staticResult !== true) {
    throw new Error(asset.symbol + ": transfer simulation returned false");
  }

  const estimatedGas = await token.transfer.estimateGas(recipient, amount);

  return {
    asset,
    token,
    amount,
    treasuryBalance,
    faucetBalance,
    estimatedGas,
  };
}

async function main() {
  const { claims, dryRun } = parseArgs(process.argv.slice(2));
  const rpcUrl = requiredEnv("RH_TESTNET_RPC_URL");
  const treasuryPrivateKey = requiredEnv("TREASURY_PRIVATE_KEY");
  const state = await loadDeployment();

  const provider = new JsonRpcProvider(rpcUrl);

  try {
    const network = await provider.getNetwork();
    if (network.chainId !== CHAIN_ID) {
      throw new Error(
        "Wrong network: expected " + CHAIN_ID.toString() + ", got " + network.chainId.toString()
      );
    }

    const wallet = new Wallet(treasuryPrivateKey, provider);
    const treasury = getAddress(TREASURY_ADDRESS);
    if (getAddress(wallet.address) !== treasury) {
      throw new Error(
        "TREASURY_PRIVATE_KEY controls " +
          wallet.address +
          ", expected canonical treasury " +
          treasury
      );
    }

    const faucetAddress = getAddress(state.contractAddress);
    if (faucetAddress === treasury) {
      throw new Error("Faucet address cannot equal treasury address");
    }

    const { faucet, availableClaims: availableBefore } = await verifyFaucet(
      provider,
      faucetAddress
    );

    const nativeAmount = parseEther(PAYOUT.nativeEth) * claims;
    const tusdgAmount = parseEther(PAYOUT.tUSDG) * claims;
    const stockAmount = parseEther(PAYOUT.stockEach) * claims;

    const treasuryNativeBalance = await provider.getBalance(treasury);
    const nativeEstimatedGas = await wallet.estimateGas({
      to: faucetAddress,
      value: nativeAmount,
    });

    const tokenPlans = [];
    tokenPlans.push(
      await inspectToken(wallet, TUSDG, faucetAddress, tusdgAmount)
    );
    for (const asset of STOCK_TOKENS) {
      tokenPlans.push(
        await inspectToken(wallet, asset, faucetAddress, stockAmount)
      );
    }

    const estimatedGasTotal =
      nativeEstimatedGas +
      tokenPlans.reduce((total, item) => total + item.estimatedGas, 0n);

    const feeData = await provider.getFeeData();
    const feePerGas = feeData.maxFeePerGas ?? feeData.gasPrice;
    if (feePerGas === null) {
      throw new Error("RPC did not return a usable gas price");
    }

    const estimatedGasBudget = (estimatedGasTotal * feePerGas * 125n) / 100n;
    const requiredNative = nativeAmount + estimatedGasBudget;

    if (treasuryNativeBalance < requiredNative) {
      throw new Error(
        "Treasury native balance is insufficient. Have " +
          formatEther(treasuryNativeBalance) +
          " ETH; funding + 125% estimated gas requires about " +
          formatEther(requiredNative) +
          " ETH"
      );
    }

    const plan = {
      mode: dryRun ? "DRY_RUN" : "EXECUTE",
      chainId: CHAIN_ID.toString(),
      treasury,
      faucet: faucetAddress,
      claimsToAdd: claims.toString(),
      availableClaimsBefore: availableBefore.toString(),
      funding: {
        nativeEth: formatEther(nativeAmount),
        tUSDG: formatUnits(tusdgAmount, 18),
        eachStock: formatUnits(stockAmount, 18),
      },
      treasuryNativeBalance: formatEther(treasuryNativeBalance),
      estimatedGasTotal: estimatedGasTotal.toString(),
      estimatedGasBudgetEth: formatEther(estimatedGasBudget),
      tokenTransfers: tokenPlans.map((item) => ({
        symbol: item.asset.symbol,
        address: getAddress(item.asset.address),
        amount: formatUnits(item.amount, 18),
        treasuryBalanceBefore: formatUnits(item.treasuryBalance, 18),
        faucetBalanceBefore: formatUnits(item.faucetBalance, 18),
        estimatedGas: item.estimatedGas.toString(),
      })),
    };

    console.log(JSON.stringify(plan, null, 2));
    if (dryRun) return;

    const nativeTx = await wallet.sendTransaction({
      to: faucetAddress,
      value: nativeAmount,
    });
    console.log(
      JSON.stringify({
        event: "BROADCASTED",
        asset: "native",
        txHash: nativeTx.hash,
      })
    );
    const nativeReceipt = await nativeTx.wait(1);
    if (!nativeReceipt || nativeReceipt.status !== 1) {
      throw new Error("Native funding transaction failed");
    }
    console.log(
      JSON.stringify({
        event: "CONFIRMED",
        asset: "native",
        txHash: nativeTx.hash,
        blockNumber: nativeReceipt.blockNumber,
      })
    );

    for (const item of tokenPlans) {
      const balanceBefore = await item.token.balanceOf(faucetAddress);
      const tx = await item.token.transfer(faucetAddress, item.amount);
      console.log(
        JSON.stringify({
          event: "BROADCASTED",
          asset: item.asset.symbol,
          txHash: tx.hash,
        })
      );

      const receipt = await tx.wait(1);
      if (!receipt || receipt.status !== 1) {
        throw new Error(item.asset.symbol + ": funding transaction failed");
      }

      const balanceAfter = await item.token.balanceOf(faucetAddress);
      if (balanceAfter - balanceBefore !== item.amount) {
        throw new Error(
          item.asset.symbol + ": faucet balance delta did not match requested funding"
        );
      }

      console.log(
        JSON.stringify({
          event: "CONFIRMED",
          asset: item.asset.symbol,
          txHash: tx.hash,
          blockNumber: receipt.blockNumber,
          faucetBalanceAfter: formatUnits(balanceAfter, 18),
        })
      );
    }

    const availableAfter = await faucet.availableClaims();
    const expectedAfter = availableBefore + claims;
    if (availableAfter !== expectedAfter) {
      throw new Error(
        "Funding transactions confirmed, but availableClaims is " +
          availableAfter.toString() +
          "; expected " +
          expectedAfter.toString()
      );
    }

    console.log(
      JSON.stringify(
        {
          status: "COMPLETED",
          faucet: faucetAddress,
          claimsAdded: claims.toString(),
          availableClaimsBefore: availableBefore.toString(),
          availableClaimsAfter: availableAfter.toString(),
        },
        null,
        2
      )
    );
  } finally {
    provider.destroy();
  }
}

main().catch((error) => {
  console.error(
    JSON.stringify({
      code: "FAUCET_FUND_FAILED",
      message: error instanceof Error ? error.message : String(error),
    })
  );
  process.exitCode = 1;
});
