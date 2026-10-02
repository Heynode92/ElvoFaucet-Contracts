// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

interface IFaucetClaim {
    function claimFor(address recipient) external;
}

/// @dev Test-only recipient that rejects native currency.
contract RejectNativeRecipient {
    receive() external payable {
        revert("native rejected");
    }
}

/// @dev Test-only recipient that attempts to re-enter claimFor when native payout arrives.
contract ReentrantRecipient {
    IFaucetClaim public immutable faucet;
    address public immutable secondRecipient;
    bool public reentrySucceeded;

    constructor(address faucet_, address secondRecipient_) {
        faucet = IFaucetClaim(faucet_);
        secondRecipient = secondRecipient_;
    }

    receive() external payable {
        (bool success,) = address(faucet).call(
            abi.encodeWithSelector(IFaucetClaim.claimFor.selector, secondRecipient)
        );
        reentrySucceeded = success;
    }
}
