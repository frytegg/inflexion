// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { ECDSA } from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import { SignatureChecker } from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";

import { InflexionCore } from "../InflexionCore.sol";

/// @title  QuoteVerification — EIP-712 Path-B quote hashing + signature verification
/// @notice Extracted from InflexionCore (bytecode size). Houses the EIP-712 struct
///         hash, the typed-data digest assembly (`\x19\x01 || domainSeparator ||
///         structHash`, identical to OZ `_hashTypedDataV4`), ECDSA recovery, and the
///         SignatureChecker (ECDSA + EIP-1271 STATICCALL fallback) path — previously
///         inlined and DUPLICATED across createSwap and the quote predicate.
/// @dev    PURE CODE MOTION: the `SIGNED_QUOTE_TYPEHASH` type string and the
///         `abi.encode` field order are byte-identical to the former in-core versions,
///         so the digest — and therefore signer recovery and every test that
///         recomputes it off the public domainSeparator — is unchanged. View/pure
///         only: no state writes, no value transfer; I7/I9 enforcement stays in core.
///         References `InflexionCore.SignedQuote` (type-only import) so the
///         test-facing `InflexionCore.SignedQuote` surface is preserved.
library QuoteVerification {
    bytes32 internal constant SIGNED_QUOTE_TYPEHASH = keccak256(
        "SignedQuote(address mm,bytes32 marketId,uint16 loadBps,uint16 minMaxILRatioBps,uint16 maxMaxILRatioBps,uint128 quotePrice,uint16 priceBandBps,uint8 model,uint16 partialRatioBps,uint128 maxNotionalV0,uint64 validUntil,bytes32 quoteId,uint256 nonce)"
    );

    /// @notice EIP-712 struct hash of a quote (signature excluded). Byte-identical to
    ///         the former InflexionCore.hashQuote.
    function hashQuote(
        InflexionCore.SignedQuote calldata q
    ) public pure returns (bytes32) {
        return keccak256(
            abi.encode(
                SIGNED_QUOTE_TYPEHASH,
                q.mm,
                q.marketId,
                q.loadBps,
                q.minMaxILRatioBps,
                q.maxMaxILRatioBps,
                q.quotePrice,
                q.priceBandBps,
                q.model,
                q.partialRatioBps,
                q.maxNotionalV0,
                q.validUntil,
                q.quoteId,
                q.nonce
            )
        );
    }

    /// @dev EIP-712 typed-data digest. Identical to OZ `_hashTypedDataV4(hashQuote(q))`.
    function _digest(
        bytes32 domainSeparator,
        InflexionCore.SignedQuote calldata q
    ) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(hex"1901", domainSeparator, hashQuote(q)));
    }

    /// @notice Recover the signer of a quote (ECDSA). Byte-identical to the former
    ///         InflexionCore.recoverSigner (which did `_hashTypedDataV4(hashQuote(q))`).
    function recoverSigner(
        bytes32 domainSeparator,
        InflexionCore.SignedQuote calldata q,
        bytes calldata sig
    ) public pure returns (address) {
        return ECDSA.recover(_digest(domainSeparator, q), sig);
    }

    /// @notice EOA (ECDSA) + smart-contract (EIP-1271) signature validity for `signer`.
    ///         Identical to the former inline
    ///         `SignatureChecker.isValidSignatureNow(signer, _hashTypedDataV4(hashQuote(q)), sig)`.
    function isSignatureValid(
        bytes32 domainSeparator,
        InflexionCore.SignedQuote calldata q,
        address signer,
        bytes calldata sig
    ) public view returns (bool) {
        return SignatureChecker.isValidSignatureNow(signer, _digest(domainSeparator, q), sig);
    }
}
