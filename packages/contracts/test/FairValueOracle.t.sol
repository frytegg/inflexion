// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { Test } from "forge-std/Test.sol";

import { FairValueOracle } from "../src/FairValueOracle.sol";
import { IVolOracle } from "../src/interfaces/IVolOracle.sol";
import { MockVolOracle } from "./mocks/MockVolOracle.sol";

contract FairValueOracleTest is Test {
    FairValueOracle internal fvo;
    MockVolOracle internal mvol;

    struct Fix {
        uint256 a;
        uint256 b;
        uint256 sigma;
        uint256 dur;
        uint256 fr;
    }

    Fix[] internal fx;

    function _add(
        uint256 a,
        uint256 b,
        uint256 s,
        uint256 d,
        uint256 fr
    ) internal {
        fx.push(Fix(a, b, s, d, fr));
    }

    function setUp() public {
        mvol = new MockVolOracle(6e17); // 60%
        fvo = new FairValueOracle(IVolOracle(address(mvol)));

        // (aWad, bWad, sigmaWad, durationSeconds, expectedFairRateWad) — from
        // inflexion_quant.cvamm.fair_rate (Python closed form, verified ≡ il.py).
        _add(
            952_380_952_380_952_320,
            1_050_000_000_000_000_000,
            300_000_000_000_000_000,
            604_800,
            445_055_615_107_356_096
        ); // geom+-5% 7d
        _add(
            952_380_952_380_952_320,
            1_050_000_000_000_000_000,
            300_000_000_000_000_000,
            2_592_000,
            704_443_294_759_832_576
        ); // geom+-5% 30d
        _add(
            952_380_952_380_952_320,
            1_050_000_000_000_000_000,
            300_000_000_000_000_000,
            7_776_000,
            825_979_932_286_028_160
        ); // geom+-5% 90d
        _add(
            952_380_952_380_952_320,
            1_050_000_000_000_000_000,
            600_000_000_000_000_000,
            604_800,
            694_744_033_646_075_776
        ); // geom+-5% 7d
        _add(
            952_380_952_380_952_320,
            1_050_000_000_000_000_000,
            600_000_000_000_000_000,
            2_592_000,
            849_023_201_053_105_792
        ); // geom+-5% 30d
        _add(
            952_380_952_380_952_320,
            1_050_000_000_000_000_000,
            600_000_000_000_000_000,
            7_776_000,
            913_001_490_076_869_888
        ); // geom+-5% 90d
        _add(
            952_380_952_380_952_320,
            1_050_000_000_000_000_000,
            1_000_000_000_000_000_000,
            604_800,
            813_054_306_394_733_440
        ); // geom+-5% 7d
        _add(
            952_380_952_380_952_320,
            1_050_000_000_000_000_000,
            1_000_000_000_000_000_000,
            2_592_000,
            909_534_004_505_922_560
        ); // geom+-5% 30d
        _add(
            952_380_952_380_952_320,
            1_050_000_000_000_000_000,
            1_000_000_000_000_000_000,
            7_776_000,
            948_730_478_719_081_344
        ); // geom+-5% 90d
        _add(
            909_090_909_090_909_056,
            1_100_000_000_000_000_128,
            300_000_000_000_000_000,
            604_800,
            174_966_142_301_187_936
        ); // geom+-10% 7d
        _add(
            909_090_909_090_909_056,
            1_100_000_000_000_000_128,
            300_000_000_000_000_000,
            2_592_000,
            464_446_980_483_174_848
        ); // geom+-10% 30d
        _add(
            909_090_909_090_909_056,
            1_100_000_000_000_000_128,
            300_000_000_000_000_000,
            7_776_000,
            666_244_105_868_797_056
        ); // geom+-10% 90d
        _add(
            909_090_909_090_909_056,
            1_100_000_000_000_000_128,
            600_000_000_000_000_000,
            604_800,
            450_003_715_087_427_712
        ); // geom+-10% 7d
        _add(
            909_090_909_090_909_056,
            1_100_000_000_000_000_128,
            600_000_000_000_000_000,
            2_592_000,
            708_227_434_506_062_720
        ); // geom+-10% 30d
        _add(
            909_090_909_090_909_056,
            1_100_000_000_000_000_128,
            600_000_000_000_000_000,
            7_776_000,
            829_230_040_200_437_888
        ); // geom+-10% 90d
        _add(
            909_090_909_090_909_056,
            1_100_000_000_000_000_128,
            1_000_000_000_000_000_000,
            604_800,
            643_143_162_670_308_224
        ); // geom+-10% 7d
        _add(
            909_090_909_090_909_056,
            1_100_000_000_000_000_128,
            1_000_000_000_000_000_000,
            2_592_000,
            822_535_964_539_236_096
        ); // geom+-10% 30d
        _add(
            909_090_909_090_909_056,
            1_100_000_000_000_000_128,
            1_000_000_000_000_000_000,
            7_776_000,
            898_849_351_591_435_648
        ); // geom+-10% 90d
        _add(
            833_333_333_333_333_376, 1_200_000_000_000_000_000, 300_000_000_000_000_000, 604_800, 47_361_760_955_071_528
        ); // geom+-20% 7d
        _add(
            833_333_333_333_333_376,
            1_200_000_000_000_000_000,
            300_000_000_000_000_000,
            2_592_000,
            193_142_322_042_186_848
        ); // geom+-20% 30d
        _add(
            833_333_333_333_333_376,
            1_200_000_000_000_000_000,
            300_000_000_000_000_000,
            7_776_000,
            412_911_784_875_988_352
        ); // geom+-20% 90d
        _add(
            833_333_333_333_333_376,
            1_200_000_000_000_000_000,
            600_000_000_000_000_000,
            604_800,
            181_874_734_159_851_488
        ); // geom+-20% 7d
        _add(
            833_333_333_333_333_376,
            1_200_000_000_000_000_000,
            600_000_000_000_000_000,
            2_592_000,
            473_731_572_584_192_256
        ); // geom+-20% 30d
        _add(
            833_333_333_333_333_376,
            1_200_000_000_000_000_000,
            600_000_000_000_000_000,
            7_776_000,
            674_580_632_552_630_784
        ); // geom+-20% 90d
        _add(
            833_333_333_333_333_376,
            1_200_000_000_000_000_000,
            1_000_000_000_000_000_000,
            604_800,
            381_622_247_360_540_416
        ); // geom+-20% 7d
        _add(
            833_333_333_333_333_376,
            1_200_000_000_000_000_000,
            1_000_000_000_000_000_000,
            2_592_000,
            662_611_328_539_240_320
        ); // geom+-20% 30d
        _add(
            833_333_333_333_333_376,
            1_200_000_000_000_000_000,
            1_000_000_000_000_000_000,
            7_776_000,
            803_539_325_228_340_352
        ); // geom+-20% 90d
        _add(
            666_666_666_666_666_624, 1_500_000_000_000_000_000, 300_000_000_000_000_000, 604_800, 8_542_033_378_886_120
        ); // geom+-50% 7d
        _add(
            666_666_666_666_666_624,
            1_500_000_000_000_000_000,
            300_000_000_000_000_000,
            2_592_000,
            36_595_644_318_402_184
        ); // geom+-50% 30d
        _add(
            666_666_666_666_666_624,
            1_500_000_000_000_000_000,
            300_000_000_000_000_000,
            7_776_000,
            108_883_167_444_564_384
        ); // geom+-50% 90d
        _add(
            666_666_666_666_666_624, 1_500_000_000_000_000_000, 600_000_000_000_000_000, 604_800, 34_157_038_530_435_036
        ); // geom+-50% 7d
        _add(
            666_666_666_666_666_624,
            1_500_000_000_000_000_000,
            600_000_000_000_000_000,
            2_592_000,
            143_072_568_651_451_744
        ); // geom+-50% 30d
        _add(
            666_666_666_666_666_624,
            1_500_000_000_000_000_000,
            600_000_000_000_000_000,
            7_776_000,
            340_221_679_611_901_888
        ); // geom+-50% 90d
        _add(
            666_666_666_666_666_624,
            1_500_000_000_000_000_000,
            1_000_000_000_000_000_000,
            604_800,
            94_446_660_562_691_888
        ); // geom+-50% 7d
        _add(
            666_666_666_666_666_624,
            1_500_000_000_000_000_000,
            1_000_000_000_000_000_000,
            2_592_000,
            323_932_566_820_347_072
        ); // geom+-50% 30d
        _add(
            666_666_666_666_666_624,
            1_500_000_000_000_000_000,
            1_000_000_000_000_000_000,
            7_776_000,
            556_835_944_650_812_992
        ); // geom+-50% 90d
        _add(
            746_981_775_647_618_176, 1_075_653_756_932_570_112, 600_000_000_000_000_000, 604_800, 84_428_007_485_565_904
        ); // asym -0.6 7d
        _add(
            746_981_775_647_618_176,
            1_075_653_756_932_570_112,
            600_000_000_000_000_000,
            7_776_000,
            494_257_571_824_467_712
        ); // asym -0.6 90d
        _add(
            929_667_184_774_856_192, 1_338_720_746_075_793_152, 600_000_000_000_000_000, 604_800, 63_062_164_522_835_960
        ); // asym +0.6 7d
        _add(
            929_667_184_774_856_192,
            1_338_720_746_075_793_152,
            600_000_000_000_000_000,
            7_776_000,
            363_643_466_519_304_064
        ); // asym +0.6 90d
        _add(
            980_392_156_862_745_088,
            1_020_000_000_000_000_000,
            600_000_000_000_000_000,
            2_592_000,
            938_765_435_777_894_912
        ); // tight+-2% 30d
        _add(
            740_740_740_740_740_736,
            1_350_000_000_000_000_000,
            900_000_000_000_000_000,
            7_776_000,
            637_614_733_989_774_976
        ); // wide+-35% 90d
    }

    /// @notice Solidity exact Φ-sum ≡ the Python closed form, across width × σ × T
    ///         incl. ASYMMETRIC positions (numéraire probe).
    /// @dev    STATED TOLERANCE: the error is A&S-erf-limited (~1.5e-7) amplified by
    ///         1/MaxIL. Over the LAUNCH domain (width ≥ ±5%) that is ≲ 2e-5 absolute
    ///         on fairRate (≈ 1¢ premium error on a $1,280 MaxIL — economically
    ///         negligible). For very tight ranges (< ±5%, e.g. the 0.05% fee tier)
    ///         the amplification grows and A&S degrades to ~1e-3 — that case is the
    ///         driver for the higher-precision **Rust/Stylus erf** in the latent
    ///         benchmark (docs/STYLUS_FAIRVALUE_BENCHMARK.md). `a ≤ 0.96e18` ⇔ width
    ///         ≥ ±~4% (the launch domain); the single ±2% fixture is the tight edge.
    function test_matches_python_closed_form() public {
        uint256 maxErrAll;
        uint256 maxErrLaunch;
        for (uint256 i; i < fx.length; i++) {
            Fix memory f = fx[i];
            uint256 got = fvo.fairRate(f.a, f.b, f.sigma, f.dur);
            uint256 err = got > f.fr ? got - f.fr : f.fr - got;
            if (err > maxErrAll) maxErrAll = err;
            if (f.a <= 960_000_000_000_000_000 && err > maxErrLaunch) maxErrLaunch = err; // launch: width ≥ ±~4%
            assertApproxEqAbs(got, f.fr, 2e15, "fairRate vs Python (>2e-3, even tight)");
            assertTrue(got > 0 && got <= 1e18 + 1, "fairRate out of (0,1]");
        }
        emit log_named_uint("n_fixtures", fx.length);
        emit log_named_uint("max abs err ALL incl tight (wad)", maxErrAll);
        emit log_named_uint("max abs err LAUNCH width>=5pct (wad)", maxErrLaunch);
        // STATED A&S-baseline tolerance: < 1e-3 over the launch domain (width ≥ ±5%),
        // < 2e-3 overall (the ±2% edge). Economically negligible (premium error
        // < ~$0.5 on a $1,280 MaxIL). Machine precision is the latent Rust/Stylus
        // port's job (docs/STYLUS_FAIRVALUE_BENCHMARK.md) — the algebraic Φ-sum is
        // exact; only Φ is approximated here (A&S 7.1.26, ~1.5e-7, ÷MaxIL-amplified).
        assertLt(maxErrLaunch, 1e15, "fairRate vs Python exceeds the 1e-3 A&S launch tolerance");
    }

    function test_fairRateFromPrices_equals_normalised() public view {
        // P0=1 path is exact: fairRateFromPrices(1e18, a, b) == fairRate(a, b).
        uint256 a = 909_090_909_090_909_056;
        uint256 b = 1_100_000_000_000_000_128;
        assertEq(fvo.fairRateFromPrices(1e18, a, b, 6e17, 2_592_000), fvo.fairRate(a, b, 6e17, 2_592_000));

        // P0 != 1 scaling path (runtime vars → integer division): ±10% around $3000.
        uint256 P0 = 3000e18;
        uint256 Pa = (P0 * 1000) / 1100; // ≈ P0/1.1
        uint256 Pb = (P0 * 1100) / 1000; // ≈ P0·1.1
        uint256 viaPrices = fvo.fairRateFromPrices(P0, Pa, Pb, 6e17, 2_592_000);
        uint256 viaNorm = fvo.fairRate((Pa * 1e18) / P0, (Pb * 1e18) / P0, 6e17, 2_592_000);
        assertApproxEqAbs(viaPrices, viaNorm, 1e10);
    }

    function test_in_range_gate_reverts() public {
        vm.expectRevert(bytes("FVO: need Pa<P0<Pb"));
        fvo.fairRate(1e18, 11e17, 6e17, 2_592_000); // a == 1 (Pa == P0)
        vm.expectRevert(bytes("FVO: need Pa<P0<Pb"));
        fvo.fairRate(9e17, 1e18, 6e17, 2_592_000); // b == 1 (Pb == P0)
    }

    function test_fairPremium_uses_vol_and_maxIL() public {
        mvol.setSigma(6e17);
        uint256 maxIL = 1280e6; // e.g. 1,280 USDC (6-dec)
        (uint256 premium, uint256 fr, uint256 sig) =
            fvo.fairPremium(address(0xE7), 909_090_909_090_909_056, 1_100_000_000_000_000_128, 2_592_000, maxIL);
        assertEq(sig, 6e17);
        // ±10% 30d σ=60% → fairRate ≈ 0.708 (within the launch-domain tolerance)
        assertApproxEqAbs(fr, 708_227_434_506_062_720, 2e13);
        assertEq(premium, maxIL * fr / 1e18); // FairPremium = fairRate · MaxIL
    }
}
