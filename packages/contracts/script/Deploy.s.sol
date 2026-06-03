// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {OracleManager} from "../src/OracleManager.sol";
import {VolOracle} from "../src/VolOracle.sol";
import {ILMath} from "../src/ILMath.sol";
import {ILVault} from "../src/ILVault.sol";
import {UnderwriterVault} from "../src/UnderwriterVault.sol";
import {ConvexityVault} from "../src/ConvexityVault.sol";
import {InflexionCore} from "../src/InflexionCore.sol";
import {IOracleManager} from "../src/interfaces/IOracleManager.sol";
import {IConvexityVault} from "../src/interfaces/IConvexityVault.sol";
import {IFairValueOracle} from "../src/interfaces/IFairValueOracle.sol";
import {IVolOracle} from "../src/interfaces/IVolOracle.sol";
import {CvammPricing} from "../src/libraries/CvammPricing.sol";

/// @dev Minimal interface to wire the deployed Stylus `FairValueOracle` (set-once
///      `init(vol)` — the Stylus analogue of the Solidity constructor arg).
interface IStylusFvoInit {
    function init(address vol) external;
}

/// @title  Deploy — full cvAMM stack to Arbitrum Sepolia (P3.10), Stylus-shipped
/// @notice Deploys OracleManager + VolOracle + ILMath + ILVault + UnderwriterVault
///         + ConvexityVault + InflexionCore, then wires core at the **Stylus**
///         FairValueOracle (deployed separately via `cargo stylus deploy`, passed
///         as `STYLUS_FVO`). ALL cvAMM primitives are read from the single
///         `quant/params.json` (cvAMM block) — no value is hardcoded (CLAUDE.md
///         inv. 6). External addresses are the verified Arbitrum Sepolia set
///         (`deployments/arbitrum-sepolia.json`), each with a source comment.
///
/// @dev    Deploy flow:
///           1. `cargo stylus deploy` the Stylus FairValueOracle → STYLUS_FVO
///           2. `STYLUS_FVO=… forge script script/Deploy.s.sol --rpc-url $SEPOLIA_RPC \
///                 --private-key $DEPLOYER_PRIVATE_KEY --broadcast`
///         The script `init`s the Stylus FVO to the freshly-deployed VolOracle and
///         points `core.setCvamm` at it. Record the logged addresses in
///         `deployments/arbitrum-sepolia.json`.
///
///         ⚠️ **NUMÉRAIRE / token ordering.** The protocol's numéraire is
///         `token1` (must be the stable, USDC). A Uniswap v3 pool stores
///         `token0 < token1` by address. On Arbitrum One WETH(0x82aF) < USDC(0xaf88)
///         so token1 = USDC ✓. On Arbitrum **Sepolia** USDC(0x75fa) < WETH(0x980B),
///         so a vanilla WETH/USDC pool has token1 = WETH ✗. The demo therefore
///         needs a USDC whose address is **above** WETH (a custom test USDC) or a
///         different stable. Pass the market tokens via env (TOKEN0/TOKEN1/
///         ORACLE_TOKEN/decimals); if unset, market registration is skipped (the
///         stack still deploys + wires) — register markets once the demo token set
///         is chosen. There is also no pre-seeded WETH/USDC v3 pool on Sepolia (see
///         deployments/arbitrum-sepolia.json `tokens._poolNote`) — seed one for the
///         demo (Factory.createPool → initialize → NPM.mint).
contract Deploy is Script {
    using stdJson for string;

    // ── Verified Arbitrum Sepolia externals (deployments/arbitrum-sepolia.json) ──
    address internal constant NPM = 0x6b2937Bde17889EDCf8fbD8dE31C3C2a70Bc4d65; // Uniswap v3 NPM
    address internal constant ETH_USD = 0xd30e2101a97dcbAeBCBC04F14C3f624E67A35165; // Chainlink ETH/USD (8 dec)
    address internal constant SEQUENCER = address(0); // no L2 sequencer-uptime feed on Sepolia → skip-check
    address internal constant WETH = 0x980B62Da83eFf3D4576C647993b0c1D7faf17c73; // Uniswap-referenced WETH9 (18 dec)
    uint256 internal constant STALENESS = 90_000; // per-token; same value works on either chain

    function run() external {
        string memory pj = vm.readFile("../../quant/params.json");

        // ── cvAMM params (single source: quant/params.json #/cvamm) ──────────
        VolOracle vol;
        CvammPricing.LoadParams memory lp = _readLoadParams(pj);
        uint256 cooldown = pj.readUint(".cvamm.convexity_vault.withdrawal_cooldown_seconds");
        uint256 seniorShareBps = pj.readUint(".cvamm.convexity_vault.senior_premium_share_bps");

        address usdc = vm.envOr("USDC", address(0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d)); // Circle Sepolia USDC (6 dec)
        address stylusFvo = vm.envAddress("STYLUS_FVO"); // deployed via cargo stylus deploy
        address treasury = vm.envOr("TREASURY", msg.sender);

        vm.startBroadcast();

        // ── deploy ───────────────────────────────────────────────────────────
        OracleManager oracle = new OracleManager(SEQUENCER);
        oracle.setPriceFeed(WETH, ETH_USD, STALENESS);

        vol = new VolOracle(
            IOracleManager(address(oracle)),
            uint32(pj.readUint(".cvamm.vol_oracle.short_halflife_seconds")),
            uint32(pj.readUint(".cvamm.vol_oracle.long_halflife_seconds")),
            pj.readUint(".cvamm.vol_oracle.floor_wad"),
            uint32(pj.readUint(".cvamm.vol_oracle.min_sample_interval_seconds")),
            uint32(pj.readUint(".cvamm.vol_oracle.max_sample_interval_seconds"))
        );

        ILMath ilMath = new ILMath();
        ILVault ilVault = new ILVault(NPM);
        UnderwriterVault uVault = new UnderwriterVault(IERC20(usdc));
        ConvexityVault cVault = new ConvexityVault(IERC20(usdc), cooldown, seniorShareBps);
        InflexionCore core = new InflexionCore(IERC20(usdc), oracle, ilMath, uVault, ilVault, NPM, treasury);

        // ── wire ───────────────────────────────────────────────────────────────
        uVault.setCore(address(core));
        ilVault.setCore(address(core));
        cVault.setCore(address(core));

        // SHIP STYLUS: point core at the Stylus FairValueOracle (same IFairValueOracle
        // ABI as the Solidity reference; init wires it to this VolOracle).
        IStylusFvoInit(stylusFvo).init(address(vol));
        core.setCvamm(IConvexityVault(address(cVault)), IFairValueOracle(stylusFvo), IVolOracle(address(vol)));
        core.setLoadParams(lp);

        // ── markets (optional — needs the numéraire-correct token set; see header) ─
        _registerMarketsIfConfigured(core);

        vm.stopBroadcast();

        // ── log addresses for deployments/arbitrum-sepolia.json ──────────────
        console2.log("=== Inflexion cvAMM stack - Arbitrum Sepolia ===");
        console2.log("oracleManager   ", address(oracle));
        console2.log("volOracle       ", address(vol));
        console2.log("ilMath          ", address(ilMath));
        console2.log("ilVault         ", address(ilVault));
        console2.log("underwriterVault", address(uVault));
        console2.log("convexityVault  ", address(cVault));
        console2.log("inflexionCore   ", address(core));
        console2.log("fairValueOracle (Stylus)", stylusFvo);
        console2.log("usdc            ", usdc);
        console2.log("treasury        ", treasury);
    }

    function _readLoadParams(string memory pj) internal pure returns (CvammPricing.LoadParams memory lp) {
        lp = CvammPricing.LoadParams({
            baseLoadCalmBps: uint16(pj.readUint(".cvamm.load_params.base_load_calm_bps")),
            baseLoadNormalBps: uint16(pj.readUint(".cvamm.load_params.base_load_normal_bps")),
            baseLoadStressedBps: uint16(pj.readUint(".cvamm.load_params.base_load_stressed_bps")),
            regimeCalmBelowWad: pj.readUint(".cvamm.load_params.regime_calm_below_wad"),
            regimeStressedAtWad: pj.readUint(".cvamm.load_params.regime_stressed_at_wad"),
            utilKneeWad: pj.readUint(".cvamm.load_params.util_knee_wad"),
            utilSlopeWad: pj.readUint(".cvamm.load_params.util_slope_wad"),
            utilPowerWad: pj.readUint(".cvamm.load_params.util_power_wad"),
            utilCapWad: pj.readUint(".cvamm.load_params.util_cap_wad"),
            dispSlopeWad: pj.readUint(".cvamm.load_params.disp_slope_wad"),
            dispPowerWad: pj.readUint(".cvamm.load_params.disp_power_wad"),
            dispCapWad: pj.readUint(".cvamm.load_params.disp_cap_wad"),
            maxLoadBps: pj.readUint(".cvamm.load_params.max_load_bps")
        });
    }

    /// @dev Registers the ETH/USDC markets (3 fee tiers × 3 durations) IFF the
    ///      numéraire-correct token set is supplied via env (TOKEN0 < TOKEN1 by
    ///      address, TOKEN1 = the USDC numéraire, ORACLE_TOKEN = WETH). Skipped
    ///      otherwise so the stack still deploys cleanly on Sepolia where the
    ///      default token ordering is inverted (see the header note).
    function _registerMarketsIfConfigured(InflexionCore core) internal {
        address t0 = vm.envOr("TOKEN0", address(0));
        address t1 = vm.envOr("TOKEN1", address(0));
        if (t0 == address(0) || t1 == address(0)) {
            console2.log("markets: SKIPPED (set TOKEN0/TOKEN1/ORACLE_TOKEN to register; see header note)");
            return;
        }
        address oracleToken = vm.envOr("ORACLE_TOKEN", WETH);
        uint8 t0Dec = uint8(vm.envOr("TOKEN0_DECIMALS", uint256(6)));
        uint8 t1Dec = uint8(vm.envOr("TOKEN1_DECIMALS", uint256(18)));

        uint24[3] memory fees = [uint24(500), 3000, 10_000];
        uint32[3] memory durations = [uint32(7 days), 30 days, 90 days];
        for (uint256 i; i < 3; i++) {
            for (uint256 j; j < 3; j++) {
                InflexionCore.MarketConfig memory cfg = InflexionCore.MarketConfig({
                    token0: t0,
                    token1: t1,
                    fee: fees[i],
                    durationSeconds: durations[j],
                    oracleToken: oracleToken,
                    token0Decimals: t0Dec,
                    token1Decimals: t1Dec,
                    oracleDecimals: 8, // Chainlink ETH/USD
                    active: true
                });
                core.registerMarket(cfg);
                core.setCvammEnabled(keccak256(abi.encodePacked(t0, t1, fees[i], durations[j])), true);
            }
        }
        console2.log("markets: registered 9 (3 fee tiers x 3 durations), cvAMM-enabled");
    }
}
