import { defineConfig } from "hardhat/config";

const compiler = {
  version: "0.8.34",
  settings: {
    optimizer: {
      enabled: true,
      runs: 10_000,
    },
    evmVersion: "cancun",
  },
  preferWasm: true,
};

export default defineConfig({
  solidity: {
    profiles: {
      default: compiler,
      production: compiler,
    },
  },
});
