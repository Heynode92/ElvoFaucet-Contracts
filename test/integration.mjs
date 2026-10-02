import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  ContractFactory,
  JsonRpcProvider,
  parseEther,
} from "ethers";

const HOST = "127.0.0.1";
const PORT = 18545;
const RPC_URL = "http://" + HOST + ":" + PORT;

const FAUCET_ARTIFACT = resolve(
  "artifacts/contracts/ElvoFaucetDistributor.sol/ElvoFaucetDistributor.json"
);
const TOKEN_ARTIFACT = resolve(
  "artifacts/contracts/test/MockERC20.sol/MockERC20.json"
);
const REENTRANT_ARTIFACT = resolve(
  "artifacts/contracts/test/TestRecipients.sol/ReentrantRecipient.json"
);
const REJECT_ARTIFACT = resolve(
  "artifacts/contracts/test/TestRecipients.sol/RejectNativeRecipient.json"
);

const STOCK_SYMBOLS = [
  "tNVDA",
  "tTSLA",
  "tAAPL",
  "tMSFT",
  "tMETA",
  "tGOOGL",
  "tAMZN",
  "tCOIN",
  "tSPY",
  "tQQQ",
];

async function readArtifact(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function waitForRpc(provider, child) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error("Hardhat node exited before becoming ready");
    }
    try {
      await provider.getBlockNumber();
      return;
    } catch {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
    }
  }
  throw new Error("Timed out waiting for Hardhat JSON-RPC");
}

function stopNode(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === "win32") {
    spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
    });
  } else {
    child.kill("SIGTERM");
  }
}

async function expectRevert(action, label) {
  let reverted = false;
  try {
    const tx = await action();
    if (tx?.wait) await tx.wait();
  } catch {
    reverted = true;
  }
  assert.equal(reverted, true, label);
}

async function deployContract(signer, contractArtifact, args = []) {
  const factory = new ContractFactory(
    contractArtifact.abi,
    contractArtifact.bytecode,
    signer
  );
  const contract = await factory.deploy(...args);
  await contract.waitForDeployment();
  return contract;
}

async function buildFixture(provider, artifacts) {
  const deployer = await provider.getSigner(0);
  const operator = await provider.getSigner(1);
  const pauser = await provider.getSigner(2);
  const user = await provider.getSigner(3);
  const attacker = await provider.getSigner(4);
  const other = await provider.getSigner(5);
  const recovery = await provider.getSigner(6);

  const tusdg = await deployContract(deployer, artifacts.token, [
    "Elvo Development USDG",
    "tUSDG",
  ]);

  const stocks = [];
  for (const symbol of STOCK_SYMBOLS) {
    stocks.push(
      await deployContract(deployer, artifacts.token, [
        "Elvo Development " + symbol,
        symbol,
      ])
    );
  }

  const faucet = await deployContract(deployer, artifacts.faucet, [
    await deployer.getAddress(),
    await operator.getAddress(),
    await pauser.getAddress(),
    await tusdg.getAddress(),
    await Promise.all(stocks.map((token) => token.getAddress())),
  ]);

  return {
    deployer,
    operator,
    pauser,
    user,
    attacker,
    other,
    recovery,
    tusdg,
    stocks,
    faucet,
  };
}

async function fundFixture(fixture, claims = 5n) {
  const faucetAddress = await fixture.faucet.getAddress();

  await (
    await fixture.deployer.sendTransaction({
      to: faucetAddress,
      value: parseEther("0.0005") * claims,
    })
  ).wait();

  await (
    await fixture.tusdg.mint(faucetAddress, parseEther("10") * claims)
  ).wait();

  for (const token of fixture.stocks) {
    await (
      await token.mint(faucetAddress, parseEther("0.1") * claims)
    ).wait();
  }
}

async function main() {
  const command =
    "npx hardhat node --hostname " + HOST + " --port " + String(PORT);
  const child = spawn(command, {
    cwd: process.cwd(),
    shell: true,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  let nodeLogs = "";
  child.stdout.on("data", (chunk) => {
    nodeLogs += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    nodeLogs += chunk.toString();
  });

  const provider = new JsonRpcProvider(RPC_URL);

  try {
    await waitForRpc(provider, child);

    const artifacts = {
      faucet: await readArtifact(FAUCET_ARTIFACT),
      token: await readArtifact(TOKEN_ARTIFACT),
      reentrant: await readArtifact(REENTRANT_ARTIFACT),
      reject: await readArtifact(REJECT_ARTIFACT),
    };

    console.log("1/9 deployment configuration");
    {
      const f = await buildFixture(provider, artifacts);
      assert.equal(await f.faucet.NATIVE_PAYOUT(), parseEther("0.0005"));
      assert.equal(await f.faucet.TUSDG_PAYOUT(), parseEther("10"));
      assert.equal(await f.faucet.STOCK_PAYOUT(), parseEther("0.1"));
      assert.equal(await f.faucet.STOCK_TOKEN_COUNT(), 10n);
      assert.equal(
        (await f.faucet.tUSDG()).toLowerCase(),
        (await f.tusdg.getAddress()).toLowerCase()
      );
      const configured = await f.faucet.stockTokens();
      assert.equal(configured.length, 10);
      for (let i = 0; i < configured.length; i += 1) {
        assert.equal(
          configured[i].toLowerCase(),
          (await f.stocks[i].getAddress()).toLowerCase()
        );
      }
    }

    console.log("2/9 successful gasless recipient claim");
    {
      const f = await buildFixture(provider, artifacts);
      await fundFixture(f, 5n);

      assert.equal(await f.faucet.availableClaims(), 5n);
      const recipient = await f.user.getAddress();
      const nativeBefore = await provider.getBalance(recipient);

      await (await f.faucet.connect(f.operator).claimFor(recipient)).wait();

      const nativeAfter = await provider.getBalance(recipient);
      assert.equal(nativeAfter - nativeBefore, parseEther("0.0005"));
      assert.equal(await f.tusdg.balanceOf(recipient), parseEther("10"));
      for (const token of f.stocks) {
        assert.equal(await token.balanceOf(recipient), parseEther("0.1"));
      }
      assert.equal(await f.faucet.claimed(recipient), true);
      assert.equal(await f.faucet.availableClaims(), 4n);
    }

    console.log("3/9 lifetime claim enforcement and authorization");
    {
      const f = await buildFixture(provider, artifacts);
      await fundFixture(f, 5n);

      const recipient = await f.user.getAddress();
      await (await f.faucet.connect(f.operator).claimFor(recipient)).wait();

      await expectRevert(
        () => f.faucet.connect(f.operator).claimFor(recipient),
        "second claim must revert"
      );

      const other = await f.other.getAddress();
      await expectRevert(
        () => f.faucet.connect(f.attacker).claimFor(other),
        "unauthorized caller must revert"
      );
      assert.equal(await f.faucet.claimed(other), false);
    }

    console.log("4/9 pause separation");
    {
      const f = await buildFixture(provider, artifacts);
      await fundFixture(f, 2n);
      const recipient = await f.user.getAddress();
      await (await f.faucet.connect(f.pauser).pause()).wait();

      await expectRevert(
        () => f.faucet.connect(f.operator).claimFor(recipient),
        "claim while paused must revert"
      );
      await expectRevert(
        () => f.faucet.connect(f.pauser).unpause(),
        "pauser must not be able to unpause"
      );

      await (await f.faucet.connect(f.deployer).unpause()).wait();
      assert.equal(await f.faucet.paused(), false);
    }

    console.log("5/9 atomic rollback on token failure");
    {
      const f = await buildFixture(provider, artifacts);
      await fundFixture(f, 2n);
      const recipient = await f.user.getAddress();
      const nativeBefore = await provider.getBalance(recipient);

      await (await f.stocks[4].setTransfersBlocked(true)).wait();

      await expectRevert(
        () => f.faucet.connect(f.operator).claimFor(recipient),
        "blocked token must revert complete claim"
      );

      assert.equal(await f.faucet.claimed(recipient), false);
      assert.equal(await provider.getBalance(recipient), nativeBefore);
      assert.equal(await f.tusdg.balanceOf(recipient), 0n);
      for (const token of f.stocks) {
        assert.equal(await token.balanceOf(recipient), 0n);
      }
    }

    console.log("6/9 native-transfer failure rollback");
    {
      const f = await buildFixture(provider, artifacts);
      await fundFixture(f, 2n);

      const reject = await deployContract(f.deployer, artifacts.reject, []);
      const recipient = await reject.getAddress();

      await expectRevert(
        () => f.faucet.connect(f.operator).claimFor(recipient),
        "native rejection must revert complete claim"
      );

      assert.equal(await f.faucet.claimed(recipient), false);
      assert.equal(await f.tusdg.balanceOf(recipient), 0n);
      for (const token of f.stocks) {
        assert.equal(await token.balanceOf(recipient), 0n);
      }
    }

    console.log("7/9 reentrancy protection");
    {
      const f = await buildFixture(provider, artifacts);
      await fundFixture(f, 4n);

      const secondRecipient = await f.other.getAddress();
      const reentrant = await deployContract(
        f.deployer,
        artifacts.reentrant,
        [await f.faucet.getAddress(), secondRecipient]
      );
      const reentrantAddress = await reentrant.getAddress();

      const operatorRole = await f.faucet.OPERATOR_ROLE();
      await (
        await f.faucet
          .connect(f.deployer)
          .grantRole(operatorRole, reentrantAddress)
      ).wait();

      await (
        await f.faucet.connect(f.operator).claimFor(reentrantAddress)
      ).wait();

      assert.equal(await reentrant.reentrySucceeded(), false);
      assert.equal(await f.faucet.claimed(reentrantAddress), true);
      assert.equal(await f.faucet.claimed(secondRecipient), false);
    }

    console.log("8/9 emergency recovery boundaries");
    {
      const f = await buildFixture(provider, artifacts);
      await fundFixture(f, 2n);

      const recoveryAddress = await f.recovery.getAddress();
      const tusdgAddress = await f.tusdg.getAddress();

      await expectRevert(
        () =>
          f.faucet
            .connect(f.deployer)
            .recoverNative(recoveryAddress, parseEther("0.0005")),
        "recovery while active must revert"
      );

      await (await f.faucet.connect(f.pauser).pause()).wait();

      await expectRevert(
        () =>
          f.faucet
            .connect(f.attacker)
            .recoverERC20(tusdgAddress, recoveryAddress, parseEther("1")),
        "non-admin recovery must revert"
      );

      const tokenBefore = await f.tusdg.balanceOf(recoveryAddress);
      await (
        await f.faucet
          .connect(f.deployer)
          .recoverERC20(tusdgAddress, recoveryAddress, parseEther("1"))
      ).wait();
      assert.equal(
        (await f.tusdg.balanceOf(recoveryAddress)) - tokenBefore,
        parseEther("1")
      );
    }

    console.log("9/9 constructor safety and inventory gate");
    {
      const f = await buildFixture(provider, artifacts);

      assert.equal(await f.faucet.availableClaims(), 0n);
      assert.equal(await f.faucet.canClaim(await f.user.getAddress()), false);

      const recipient = await f.user.getAddress();
      await expectRevert(
        () => f.faucet.connect(f.operator).claimFor(recipient),
        "empty inventory must revert"
      );

      const stockAddresses = await Promise.all(
        f.stocks.map((token) => token.getAddress())
      );
      const factory = new ContractFactory(
        artifacts.faucet.abi,
        artifacts.faucet.bytecode,
        f.deployer
      );
      const adminAddress = await f.deployer.getAddress();
      const operatorAddress = await f.operator.getAddress();
      const pauserAddress = await f.pauser.getAddress();
      const tusdgAddress = await f.tusdg.getAddress();

      await expectRevert(
        () =>
          factory.deploy(
            adminAddress,
            adminAddress,
            pauserAddress,
            tusdgAddress,
            stockAddresses
          ),
        "privileged role collision must revert"
      );

      const duplicateStocks = [...stockAddresses];
      duplicateStocks[9] = duplicateStocks[0];

      await expectRevert(
        () =>
          factory.deploy(
            adminAddress,
            operatorAddress,
            pauserAddress,
            tusdgAddress,
            duplicateStocks
          ),
        "duplicate stock asset must revert"
      );
    }

    console.log("All faucet contract integration tests passed.");
  } catch (error) {
    console.error(nodeLogs);
    throw error;
  } finally {
    stopNode(child);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
