import {
  Contract,
  JsonRpcProvider,
  Wallet,
  ZeroAddress,
  getAddress,
  isAddress,
} from "ethers";
import {
  CHAIN_ID,
  NETWORK_NAME,
  STOCK_TOKENS,
  TUSDG,
} from "./robinhood-testnet-config.mjs";

const ERC20_METADATA_ABI = [
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
];

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error("Missing required environment variable: " + name);
  return value;
}

function requiredAddress(name) {
  const raw = requiredEnv(name);
  if (!isAddress(raw)) throw new Error(name + " is not a valid EVM address");
  const address = getAddress(raw);
  if (address === ZeroAddress) throw new Error(name + " cannot be the zero address");
  return address;
}

function assertDistinct(values, label) {
  const normalized = values.map((value) => value.toLowerCase());
  if (new Set(normalized).size !== normalized.length) {
    throw new Error(label + " must use distinct addresses");
  }
}

async function verifyAsset(provider, asset) {
  const address = getAddress(asset.address);
  const code = await provider.getCode(address);
  if (code === "0x") throw new Error(asset.symbol + ": no deployed bytecode at " + address);

  const token = new Contract(address, ERC20_METADATA_ABI, provider);
  const [symbol, decimals] = await Promise.all([token.symbol(), token.decimals()]);

  if (symbol !== asset.symbol) {
    throw new Error(asset.symbol + ": symbol mismatch, on-chain value is " + symbol);
  }
  if (decimals !== 18n) {
    throw new Error(asset.symbol + ": expected 18 decimals, got " + decimals.toString());
  }

  return { symbol, address, decimals: Number(decimals) };
}

export async function runPreflight() {
  const rpcUrl = requiredEnv("RH_TESTNET_RPC_URL");
  const privateKey = requiredEnv("DEPLOYER_PRIVATE_KEY");
  const roles = {
    admin: requiredAddress("ADMIN_ADDRESS"),
    operator: requiredAddress("OPERATOR_ADDRESS"),
    pauser: requiredAddress("PAUSER_ADDRESS"),
  };

  assertDistinct(Object.values(roles), "ADMIN_ADDRESS, OPERATOR_ADDRESS, and PAUSER_ADDRESS");

  const provider = new JsonRpcProvider(rpcUrl);
  const network = await provider.getNetwork();
  if (network.chainId !== CHAIN_ID) {
    throw new Error(
      "Refusing operation: expected chain " +
        CHAIN_ID.toString() +
        ", got " +
        network.chainId.toString()
    );
  }

  const deployer = new Wallet(privateKey, provider);
  assertDistinct(
    [deployer.address, roles.admin, roles.operator, roles.pauser],
    "DEPLOYER, ADMIN, OPERATOR, and PAUSER"
  );

  const deployerBalance = await provider.getBalance(deployer.address);
  if (deployerBalance === 0n) {
    throw new Error("Deployer has zero native balance for deployment gas");
  }

  const verifiedAssets = [];
  verifiedAssets.push(await verifyAsset(provider, TUSDG));
  for (const asset of STOCK_TOKENS) {
    verifiedAssets.push(await verifyAsset(provider, asset));
  }

  return {
    network: NETWORK_NAME,
    chainId: network.chainId.toString(),
    deployer: getAddress(deployer.address),
    deployerBalance: deployerBalance.toString(),
    roles,
    assets: verifiedAssets,
  };
}

if (process.argv[1]?.endsWith("preflight-robinhood-testnet.mjs")) {
  runPreflight()
    .then((result) => {
      console.log(JSON.stringify({ status: "READY", ...result }, null, 2));
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    });
}
