import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Contract, ContractFactory, JsonRpcProvider, Wallet, getAddress } from "ethers";
import {
  CHAIN_ID,
  NETWORK_NAME,
  PAYOUT,
  STOCK_TOKENS,
  TUSDG,
} from "./robinhood-testnet-config.mjs";
import { runPreflight } from "./preflight-robinhood-testnet.mjs";

const ARTIFACT_FILE = resolve(
  "artifacts/contracts/ElvoFaucetDistributor.sol/ElvoFaucetDistributor.json"
);
const STATE_FILE = resolve("deployments/robinhood-testnet.json");
const STATE_SCHEMA_VERSION = 1;
const PROJECT_ID = "elvo-faucet";

async function readArtifact() {
  const artifact = JSON.parse(await readFile(ARTIFACT_FILE, "utf8"));
  if (
    !Array.isArray(artifact.abi) ||
    typeof artifact.bytecode !== "string" ||
    artifact.bytecode === "0x"
  ) {
    throw new Error("Compiled faucet artifact is missing ABI or bytecode");
  }
  return artifact;
}

async function loadState() {
  try {
    return JSON.parse(await readFile(STATE_FILE, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function verifyDeployment(provider, artifact, state, roles) {
  if (state.schemaVersion !== STATE_SCHEMA_VERSION || state.project !== PROJECT_ID) {
    throw new Error("Existing deployment state identity mismatch");
  }
  if (BigInt(state.chainId) !== CHAIN_ID) {
    throw new Error("Existing deployment state chain mismatch");
  }

  const address = getAddress(state.contractAddress);
  const code = await provider.getCode(address);
  if (code === "0x") throw new Error("Saved faucet address has no deployed bytecode");

  const faucet = new Contract(address, artifact.abi, provider);

  const [tUSDGAddress, operatorRole, pauserRole, defaultAdminRole] = await Promise.all([
    faucet.tUSDG(),
    faucet.OPERATOR_ROLE(),
    faucet.PAUSER_ROLE(),
    faucet.DEFAULT_ADMIN_ROLE(),
  ]);

  if (getAddress(tUSDGAddress) !== getAddress(TUSDG.address)) {
    throw new Error("Deployed tUSDG address mismatch");
  }

  const expectedStocks = STOCK_TOKENS.map((asset) => getAddress(asset.address));
  const deployedStocks = await faucet.stockTokens();
  if (
    deployedStocks.length !== expectedStocks.length ||
    deployedStocks.some(
      (addressValue, index) => getAddress(addressValue) !== expectedStocks[index]
    )
  ) {
    throw new Error("Deployed stock-token configuration mismatch");
  }

  const [isAdmin, isOperator, isPauser] = await Promise.all([
    faucet.hasRole(defaultAdminRole, roles.admin),
    faucet.hasRole(operatorRole, roles.operator),
    faucet.hasRole(pauserRole, roles.pauser),
  ]);

  if (!isAdmin || !isOperator || !isPauser) {
    throw new Error("Deployed privileged-role configuration mismatch");
  }

  const [nativePayout, settlementPayout, stockPayout] = await Promise.all([
    faucet.NATIVE_PAYOUT(),
    faucet.TUSDG_PAYOUT(),
    faucet.STOCK_PAYOUT(),
  ]);

  if (
    nativePayout !== 100000000000000n ||
    settlementPayout !== 10000000000000000000n ||
    stockPayout !== 100000000000000000n
  ) {
    throw new Error("Deployed payout constants mismatch");
  }

  return address;
}

function parseDeploymentMode() {
  const args = process.argv.slice(2);
  const allowed = new Set(["--new-deployment"]);
  for (const arg of args) {
    if (!allowed.has(arg)) throw new Error("Unknown deployment argument: " + arg);
  }
  return { newDeployment: args.includes("--new-deployment") };
}

async function main() {
  const mode = parseDeploymentMode();
  const preflight = await runPreflight();
  const rpcUrl = process.env.RH_TESTNET_RPC_URL.trim();
  const privateKey = process.env.DEPLOYER_PRIVATE_KEY.trim();

  const provider = new JsonRpcProvider(rpcUrl);
  const wallet = new Wallet(privateKey, provider);
  const artifact = await readArtifact();

  const existing = await loadState();
  if (existing && !mode.newDeployment) {
    const address = await verifyDeployment(
      provider,
      artifact,
      existing,
      preflight.roles
    );
    console.log("Existing deployment verified at " + address);
    return;
  }

  if (existing && mode.newDeployment) {
    console.log(
      "Explicit new deployment requested. Existing deployment " +
        getAddress(existing.contractAddress) +
        " will remain on-chain and will be superseded only after the new deployment verifies."
    );
  }

  const factory = new ContractFactory(artifact.abi, artifact.bytecode, wallet);
  const stockAddresses = STOCK_TOKENS.map((asset) => getAddress(asset.address));

  const contract = await factory.deploy(
    preflight.roles.admin,
    preflight.roles.operator,
    preflight.roles.pauser,
    getAddress(TUSDG.address),
    stockAddresses
  );

  const tx = contract.deploymentTransaction();
  if (!tx) throw new Error("Deployment transaction is unavailable");

  console.log("Deployment submitted: " + tx.hash);
  const receipt = await tx.wait(1);
  if (!receipt || receipt.status !== 1) {
    throw new Error("Faucet deployment transaction failed");
  }

  const contractAddress = getAddress(await contract.getAddress());

  const state = {
    schemaVersion: STATE_SCHEMA_VERSION,
    project: PROJECT_ID,
    network: NETWORK_NAME,
    chainId: CHAIN_ID.toString(),
    contractAddress,
    deploymentTransactionHash: tx.hash,
    deploymentBlockNumber: receipt.blockNumber,
    deployer: getAddress(wallet.address),
    roles: preflight.roles,
    payout: PAYOUT,
    assets: {
      tUSDG: TUSDG,
      stocks: STOCK_TOKENS,
    },
    deployedAt: new Date().toISOString(),
    ...(existing && mode.newDeployment
      ? {
          supersedes: {
            contractAddress: getAddress(existing.contractAddress),
            deploymentTransactionHash:
              existing.deploymentTransactionHash ?? null,
          },
        }
      : {}),
  };

  await mkdir(resolve("deployments"), { recursive: true });
  await writeFile(STATE_FILE, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });

  await verifyDeployment(provider, artifact, state, preflight.roles);

  console.log("Deployment verified at " + contractAddress);
  console.log("State written to " + STATE_FILE);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
