const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

const E = (n) => ethers.parseEther(String(n));
const U = (n) => BigInt(n) * 10n ** 6n; // 6-decimal token
const DAY = 24 * 3600;
const NATIVE = ethers.ZeroAddress;

async function deploy() {
  const [owner, treasury, maker, taker, other] = await ethers.getSigners();
  const h = await (await ethers.getContractFactory("Handshake")).deploy(owner.address, treasury.address);
  const usd = await (await ethers.getContractFactory("MockToken")).deploy("USD Test", "USDT", 6);
  const gem = await (await ethers.getContractFactory("MockToken")).deploy("Gem", "GEM", 18);
  const feeTok = await (await ethers.getContractFactory("FeeToken")).deploy();
  for (const a of [maker, taker, other]) {
    await usd.mint(a.address, U(100_000)); await gem.mint(a.address, E(100_000)); await feeTok.mint(a.address, E(1000));
    for (const t of [usd, gem, feeTok]) await t.connect(a).approve(h.target, ethers.MaxUint256);
  }
  return { h, usd, gem, feeTok, owner, treasury, maker, taker, other };
}
const later = async (d = 7) => BigInt(await time.latest()) + BigInt(d * DAY);

// maker gives 500 GEM, wants 20 BOT, open to anyone
async function gemForBot() {
  const f = await deploy();
  await f.h.connect(f.maker).create(f.gem.target, E(500), NATIVE, E(20), NATIVE, await later(), "GEM for BOT");
  return { ...f, id: 1n };
}
// maker gives 10 BOT, wants 300 USDT, only `taker` may accept
async function botForUsdPrivate() {
  const f = await deploy();
  await f.h.connect(f.maker).create(NATIVE, E(10), f.usd.target, U(300), f.taker.address, await later(), "", { value: E(10) });
  return { ...f, id: 1n };
}

describe("Handshake", () => {
  describe("create", () => {
    it("holds the maker's token deposit", async () => {
      const { h, gem, maker, id } = await loadFixture(gemForBot);
      expect(await gem.balanceOf(h.target)).to.equal(E(500));
      const o = await h.getOffer(id);
      expect(o.maker).to.equal(maker.address);
      expect(o.status).to.equal(1);
      expect(await h.offersOf(maker.address)).to.deep.equal([id]);
    });

    it("holds a BOT deposit", async () => {
      const { h } = await loadFixture(botForUsdPrivate);
      expect(await ethers.provider.getBalance(h.target)).to.equal(E(10));
    });

    it("rejects bad params and wrong value", async () => {
      const { h, gem, usd, maker } = await loadFixture(deploy);
      const exp = await later();
      await expect(h.connect(maker).create(gem.target, E(1), gem.target, 1, NATIVE, exp, "")).to.be.revertedWithCustomError(h, "InvalidParams");
      await expect(h.connect(maker).create(gem.target, 0, usd.target, 1, NATIVE, exp, "")).to.be.revertedWithCustomError(h, "InvalidParams");
      await expect(h.connect(maker).create(gem.target, 1, usd.target, 0, NATIVE, exp, "")).to.be.revertedWithCustomError(h, "InvalidParams");
      await expect(h.connect(maker).create(gem.target, 1, usd.target, 1, maker.address, exp, "")).to.be.revertedWithCustomError(h, "InvalidParams");
      await expect(h.connect(maker).create(gem.target, 1, usd.target, 1, NATIVE, BigInt(await time.latest()), "")).to.be.revertedWithCustomError(h, "InvalidParams");
      await expect(h.connect(maker).create(gem.target, 1, usd.target, 1, NATIVE, await later(366), "")).to.be.revertedWithCustomError(h, "InvalidParams");
      await expect(h.connect(maker).create(NATIVE, E(1), usd.target, 1, NATIVE, exp, "", { value: E(2) })).to.be.revertedWithCustomError(h, "WrongAmount");
      await expect(h.connect(maker).create(gem.target, 1, usd.target, 1, NATIVE, exp, "", { value: 1 })).to.be.revertedWithCustomError(h, "WrongAmount");
    });

    it("rejects fee-on-transfer tokens", async () => {
      const { h, feeTok, maker } = await loadFixture(deploy);
      await expect(h.connect(maker).create(feeTok.target, E(10), NATIVE, E(1), NATIVE, await later(), "")).to.be.revertedWithCustomError(h, "InvalidParams");
    });
  });

  describe("fill", () => {
    it("token for BOT: maker gets BOT, taker gets token minus 0.3%", async () => {
      const { h, gem, maker, taker, id } = await loadFixture(gemForBot);
      await expect(h.connect(taker).fill(id, { value: E(20) })).to.changeEtherBalances([maker, taker], [E(20), -E(20)]);
      expect(await gem.balanceOf(taker.address)).to.equal(E(100_000) + E(498.5));
      expect(await h.feesAccrued(gem.target)).to.equal(E(1.5));
      const o = await h.getOffer(id);
      expect(o.status).to.equal(2);
      expect(o.filledBy).to.equal(taker.address);
    });

    it("BOT for token, private: only the named wallet can accept", async () => {
      const { h, usd, maker, taker, other, id } = await loadFixture(botForUsdPrivate);
      await expect(h.connect(other).fill(id)).to.be.revertedWithCustomError(h, "NotAuthorized");
      await expect(h.connect(taker).fill(id)).to.changeEtherBalance(taker, E(9.97));
      expect(await usd.balanceOf(maker.address)).to.equal(U(100_300));
      expect(await h.feesAccrued(NATIVE)).to.equal(E(0.03));
    });

    it("maker can't take own offer; wrong value; only once; not after expiry", async () => {
      const { h, maker, taker, other, id } = await loadFixture(gemForBot);
      await expect(h.connect(maker).fill(id, { value: E(20) })).to.be.revertedWithCustomError(h, "NotAuthorized");
      await expect(h.connect(taker).fill(id, { value: E(19) })).to.be.revertedWithCustomError(h, "WrongAmount");
      await h.connect(taker).fill(id, { value: E(20) });
      await expect(h.connect(other).fill(id, { value: E(20) })).to.be.revertedWithCustomError(h, "NotAvailable");
      const f2 = await loadFixture(gemForBot);
      await time.increase(7 * DAY);
      await expect(f2.h.connect(f2.taker).fill(f2.id, { value: E(20) })).to.be.revertedWithCustomError(f2.h, "NotAvailable");
    });

    it("rejects fee-on-transfer token as payment", async () => {
      const { h, feeTok, gem, maker, taker } = await loadFixture(deploy);
      await h.connect(maker).create(gem.target, E(1), feeTok.target, E(10), NATIVE, await later(), "");
      await expect(h.connect(taker).fill(1)).to.be.revertedWithCustomError(h, "InvalidParams");
    });

    it("token for token", async () => {
      const { h, usd, gem, maker, taker } = await loadFixture(deploy);
      await h.connect(maker).create(usd.target, U(1000), gem.target, E(250), NATIVE, await later(), "");
      await h.connect(taker).fill(1);
      expect(await gem.balanceOf(maker.address)).to.equal(E(100_250));
      expect(await usd.balanceOf(taker.address)).to.equal(U(100_000) + U(997));
    });
  });

  describe("cancel", () => {
    it("maker gets everything back, even after expiry and while paused", async () => {
      const { h, gem, owner, maker, taker, id } = await loadFixture(gemForBot);
      await expect(h.connect(taker).cancel(id)).to.be.revertedWithCustomError(h, "NotAuthorized");
      await time.increase(30 * DAY);
      await h.connect(owner).pause();
      await expect(h.connect(maker).cancel(id)).to.changeTokenBalance(gem, maker, E(500));
      await expect(h.connect(maker).cancel(id)).to.be.revertedWithCustomError(h, "NotAvailable");
      await h.connect(owner).unpause();
      await expect(h.connect(taker).fill(id, { value: E(20) })).to.be.revertedWithCustomError(h, "NotAvailable");
    });
  });

  describe("fees & admin", () => {
    it("fees go to the treasury per token", async () => {
      const { h, gem, treasury, taker, other, id } = await loadFixture(gemForBot);
      await h.connect(taker).fill(id, { value: E(20) });
      await expect(h.connect(other).collectFees(gem.target)).to.changeTokenBalance(gem, treasury, E(1.5));
      await expect(h.collectFees(gem.target)).to.be.revertedWithCustomError(h, "NothingToCollect");
    });

    it("fee capped at 1%, owner only", async () => {
      const { h, owner, maker, treasury } = await loadFixture(deploy);
      await expect(h.connect(maker).setConfig(10, treasury.address)).to.be.revertedWithCustomError(h, "OwnableUnauthorizedAccount");
      await expect(h.connect(owner).setConfig(101, treasury.address)).to.be.revertedWithCustomError(h, "InvalidParams");
      await h.connect(owner).setConfig(0, treasury.address);
      expect(await h.feeBps()).to.equal(0);
    });

    it("pause blocks create and fill", async () => {
      const { h, gem, owner, maker, taker, id } = await loadFixture(gemForBot);
      await h.connect(owner).pause();
      await expect(h.connect(taker).fill(id, { value: E(20) })).to.be.revertedWithCustomError(h, "EnforcedPause");
      await expect(h.connect(maker).create(gem.target, 1, NATIVE, 1, NATIVE, await later(), "")).to.be.revertedWithCustomError(h, "EnforcedPause");
    });

    it("owner has no way to move deposits", async () => {
      const { h } = await loadFixture(deploy);
      const fns = h.interface.fragments.filter(x => x.type === "function" && !["view", "pure"].includes(x.stateMutability)).map(x => x.name).sort();
      expect(fns).to.deep.equal(["acceptOwnership", "cancel", "collectFees", "create", "fill", "pause", "renounceOwnership", "setConfig", "transferOwnership", "unpause"]);
    });
  });

  describe("solvency", () => {
    it("contract holds exactly open deposits plus fees, per token", async () => {
      const { h, usd, gem, maker, taker, other } = await loadFixture(deploy);
      const exp = await later();
      await h.connect(maker).create(gem.target, E(100), NATIVE, E(1), NATIVE, exp, "");      // 1 filled
      await h.connect(maker).create(gem.target, E(40), usd.target, U(7), NATIVE, exp, "");   // 2 open
      await h.connect(other).create(NATIVE, E(3), gem.target, E(9), NATIVE, exp, "", { value: E(3) }); // 3 filled
      await h.connect(other).create(NATIVE, E(5), usd.target, U(1), NATIVE, exp, "", { value: E(5) }); // 4 cancelled
      await h.connect(taker).create(usd.target, U(50), gem.target, E(2), NATIVE, exp, "");   // 5 open
      await h.connect(taker).fill(1, { value: E(1) });
      await h.connect(taker).fill(3);
      await h.connect(other).cancel(4);
      expect(await gem.balanceOf(h.target)).to.equal(E(40) + (await h.feesAccrued(gem.target)));
      expect(await usd.balanceOf(h.target)).to.equal(U(50) + (await h.feesAccrued(usd.target)));
      expect(await ethers.provider.getBalance(h.target)).to.equal(await h.feesAccrued(NATIVE));
    });
  });
});
