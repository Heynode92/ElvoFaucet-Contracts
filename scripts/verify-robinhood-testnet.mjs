import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Contract, JsonRpcProvider, getAddress, parseEther } from "ethers";
import {
  CHAIN_ID,
  PAYOUT,
  STOCK_TOKENS,
  TUSDG,
} from "./robinhood-testnet-config.mjs";

const STATE_FILE = resolve("deployments/robinhood-testnet.json");
const ARTIFACT_FILE = resolve(
  "artifacts/contracts/ElvoFaucetDistributor.sol/ElvoFaucetDistributor.json"
);

async function main() {
  const rpcUrl = process.env.RH_TESTNET_RPC_URL?.trim();
  if (!rpcUrl) throw new Error("Missing RH_TESTNET_RPC_URL");

  const [stateText, artifactText] = await Promise.all([
    readFile(STATE_FILE, "utf8"),
    readFile(ARTIFACT_FILE, "utf8"),
  ]);
  const state = JSON.parse(stateText);
  const artifact = JSON.parse(artifactText);

  const provider = new JsonRpcProvider(rpcUrl);
  const network = await provider.getNetwork();
  if (network.chainId !== CHAIN_ID) {
    throw new Error("Wrong network: " + network.chainId.toString());
  }

  const address = getAddress(state.contractAddress);
  if ((await provider.getCode(address)) === "0x") {
    throw new Error("No deployed bytecode at " + address);
  }

  const faucet = new Contract(address, artifact.abi, provider);
  const stocks = await faucet.stockTokens();

  if (getAddress(await faucet.tUSDG()) !== getAddress(TUSDG.address)) {
    throw new Error("tUSDG configuration mismatch");
  }

  for (let i = 0; i < STOCK_TOKENS.length; i += 1) {
    if (getAddress(stocks[i]) !== getAddress(STOCK_TOKENS[i].address)) {
      throw new Error("Stock configuration mismatch at index " + i);
    }
  }

  const [nativePayout, settlementPayout, stockPayout, available] = await Promise.all([
    faucet.NATIVE_PAYOUT(),
    faucet.TUSDG_PAYOUT(),
    faucet.STOCK_PAYOUT(),
    faucet.availableClaims(),
  ]);

  if (nativePayout !== parseEther(PAYOUT.nativeEth)) {
    throw new Error("Native payout configuration mismatch");
  }
  if (settlementPayout !== parseEther(PAYOUT.tUSDG)) {
    throw new Error("tUSDG payout configuration mismatch");
  }
  if (stockPayout !== parseEther(PAYOUT.stockEach)) {
    throw new Error("Stock payout configuration mismatch");
  }

  console.log(
    JSON.stringify(
      {
        status: "HEALTHY",
        chainId: network.chainId.toString(),
        contractAddress: address,
        paused: await faucet.paused(),
        payout: PAYOUT,
        availableClaims: available.toString(),
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
