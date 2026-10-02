export const CHAIN_ID = 46630n;
export const NETWORK_NAME = "Robinhood Chain Testnet";

export const TUSDG = {
  symbol: "tUSDG",
  address: "0xd6EAc08769e76F098e58fBD1B7c1f67586730688",
};

export const STOCK_TOKENS = Object.freeze([
  { symbol: "tNVDA", address: "0x35ECE565dcF1c2906AAc01f549F8da474a9F7139" },
  { symbol: "tTSLA", address: "0x5EE007379bC332A4dD47FF387702d7DbDdd8b0f0" },
  { symbol: "tAAPL", address: "0x25c2c1AF6F747988295f498B6Ea8f528Ba22804B" },
  { symbol: "tMSFT", address: "0x44BAeB47339A28e56550B428C219FB67F938c770" },
  { symbol: "tMETA", address: "0x40E32D4039B16e1Ca3FBb51F67ba06170a628Eed" },
  { symbol: "tGOOGL", address: "0x48177665c3ECcfEA1Efd402f1B35B4435eD2a27c" },
  { symbol: "tAMZN", address: "0x0460EF88Ca498Af6d9E3822712619E6405E7AC86" },
  { symbol: "tCOIN", address: "0x61d9D2a39ae0B044ABD5050E209835ad95F670DD" },
  { symbol: "tSPY", address: "0x556dA9d40Ca62097F90C56523675fF8E21e7765a" },
  { symbol: "tQQQ", address: "0xC3F36170436d1F189b202ea15D16f8C273b94b5F" },
]);

export const PAYOUT = Object.freeze({
  nativeEth: "0.0001",
  tUSDG: "10",
  stockEach: "0.1",
});
