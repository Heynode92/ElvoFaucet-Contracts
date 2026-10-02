// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {AccessControlDefaultAdminRules} from "@openzeppelin/contracts/access/extensions/AccessControlDefaultAdminRules.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title Elvo Faucet Distributor
/// @notice Testnet-only distributor for Elvo Exchange development assets on Robinhood Chain Testnet.
/// @dev Users do not submit transactions to this contract. An authorized backend operator calls
///      claimFor and pays gas. A recipient can claim exactly once for the lifetime of this contract.
contract ElvoFaucetDistributor is
    AccessControlDefaultAdminRules,
    Pausable,
    ReentrancyGuard
{
    using SafeERC20 for IERC20;

    bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    uint48 public constant DEFAULT_ADMIN_TRANSFER_DELAY = 1 days;
    uint256 public constant NATIVE_PAYOUT = 0.0005 ether;
    uint256 public constant TUSDG_PAYOUT = 10 ether;
    uint256 public constant STOCK_PAYOUT = 0.1 ether;
    uint256 public constant STOCK_TOKEN_COUNT = 10;

    IERC20 public immutable tUSDG;
    IERC20[10] private _stockTokens;

    mapping(address recipient => bool hasClaimed) public claimed;

    error InvalidAddress();
    error InvalidAssetContract(address asset);
    error DuplicateAsset(address asset);
    error PrivilegedRoleCollision();
    error AlreadyClaimed(address recipient);
    error InsufficientNativeInventory(uint256 available, uint256 required);
    error InsufficientTokenInventory(address token, uint256 available, uint256 required);
    error NativeTransferFailed(address recipient, uint256 amount);

    event ClaimExecuted(address indexed recipient, address indexed operator);
    event NativeFunded(address indexed sender, uint256 amount);
    event NativeRecovered(address indexed recipient, uint256 amount);
    event ERC20Recovered(address indexed token, address indexed recipient, uint256 amount);

    constructor(
        address initialAdmin_,
        address initialOperator_,
        address initialPauser_,
        address tUSDG_,
        address[10] memory stockTokens_
    ) AccessControlDefaultAdminRules(DEFAULT_ADMIN_TRANSFER_DELAY, initialAdmin_) {
        if (
            initialAdmin_ == address(0) ||
            initialOperator_ == address(0) ||
            initialPauser_ == address(0) ||
            tUSDG_ == address(0)
        ) {
            revert InvalidAddress();
        }

        if (
            initialAdmin_ == initialOperator_ ||
            initialAdmin_ == initialPauser_ ||
            initialOperator_ == initialPauser_
        ) {
            revert PrivilegedRoleCollision();
        }

        if (tUSDG_.code.length == 0) revert InvalidAssetContract(tUSDG_);
        tUSDG = IERC20(tUSDG_);

        for (uint256 i = 0; i < STOCK_TOKEN_COUNT; ++i) {
            address token = stockTokens_[i];
            if (token == address(0)) revert InvalidAddress();
            if (token.code.length == 0) revert InvalidAssetContract(token);
            if (token == tUSDG_) revert DuplicateAsset(token);

            for (uint256 j = 0; j < i; ++j) {
                if (token == stockTokens_[j]) revert DuplicateAsset(token);
            }

            _stockTokens[i] = IERC20(token);
        }

        _grantRole(OPERATOR_ROLE, initialOperator_);
        _grantRole(PAUSER_ROLE, initialPauser_);
    }

    receive() external payable {
        emit NativeFunded(msg.sender, msg.value);
    }

    function claimFor(address recipient)
        external
        onlyRole(OPERATOR_ROLE)
        whenNotPaused
        nonReentrant
    {
        if (recipient == address(0) || recipient == address(this)) revert InvalidAddress();
        if (claimed[recipient]) revert AlreadyClaimed(recipient);

        _requireInventory();
        claimed[recipient] = true;

        tUSDG.safeTransfer(recipient, TUSDG_PAYOUT);

        for (uint256 i = 0; i < STOCK_TOKEN_COUNT; ++i) {
            _stockTokens[i].safeTransfer(recipient, STOCK_PAYOUT);
        }

        (bool sent,) = payable(recipient).call{value: NATIVE_PAYOUT}("");
        if (!sent) revert NativeTransferFailed(recipient, NATIVE_PAYOUT);

        emit ClaimExecuted(recipient, msg.sender);
    }

    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }

    function stockToken(uint256 index) external view returns (address) {
        return address(_stockTokens[index]);
    }

    function stockTokens() external view returns (address[10] memory assets) {
        for (uint256 i = 0; i < STOCK_TOKEN_COUNT; ++i) {
            assets[i] = address(_stockTokens[i]);
        }
    }

    function availableClaims() public view returns (uint256 available) {
        available = address(this).balance / NATIVE_PAYOUT;

        uint256 settlementClaims = tUSDG.balanceOf(address(this)) / TUSDG_PAYOUT;
        if (settlementClaims < available) available = settlementClaims;

        for (uint256 i = 0; i < STOCK_TOKEN_COUNT; ++i) {
            uint256 stockClaims = _stockTokens[i].balanceOf(address(this)) / STOCK_PAYOUT;
            if (stockClaims < available) available = stockClaims;
        }
    }

    function canClaim(address recipient) external view returns (bool) {
        return
            recipient != address(0) &&
            recipient != address(this) &&
            !paused() &&
            !claimed[recipient] &&
            availableClaims() != 0;
    }

    function recoverNative(address payable recipient, uint256 amount)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
        whenPaused
        nonReentrant
    {
        if (recipient == address(0)) revert InvalidAddress();
        if (amount > address(this).balance) {
            revert InsufficientNativeInventory(address(this).balance, amount);
        }

        (bool sent,) = recipient.call{value: amount}("");
        if (!sent) revert NativeTransferFailed(recipient, amount);

        emit NativeRecovered(recipient, amount);
    }

    function recoverERC20(IERC20 token, address recipient, uint256 amount)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
        whenPaused
        nonReentrant
    {
        if (address(token) == address(0) || recipient == address(0)) revert InvalidAddress();

        uint256 balance = token.balanceOf(address(this));
        if (amount > balance) {
            revert InsufficientTokenInventory(address(token), balance, amount);
        }

        token.safeTransfer(recipient, amount);
        emit ERC20Recovered(address(token), recipient, amount);
    }

    function _requireInventory() private view {
        uint256 nativeBalance = address(this).balance;
        if (nativeBalance < NATIVE_PAYOUT) {
            revert InsufficientNativeInventory(nativeBalance, NATIVE_PAYOUT);
        }

        uint256 settlementBalance = tUSDG.balanceOf(address(this));
        if (settlementBalance < TUSDG_PAYOUT) {
            revert InsufficientTokenInventory(
                address(tUSDG),
                settlementBalance,
                TUSDG_PAYOUT
            );
        }

        for (uint256 i = 0; i < STOCK_TOKEN_COUNT; ++i) {
            IERC20 token = _stockTokens[i];
            uint256 balance = token.balanceOf(address(this));
            if (balance < STOCK_PAYOUT) {
                revert InsufficientTokenInventory(
                    address(token),
                    balance,
                    STOCK_PAYOUT
                );
            }
        }
    }
}
