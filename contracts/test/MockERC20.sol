// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @dev Test-only token. Never deploy as a production Elvo asset.
contract MockERC20 is ERC20 {
    bool public transfersBlocked;

    error TransfersBlocked();

    constructor(string memory name_, string memory symbol_) ERC20(name_, symbol_) {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setTransfersBlocked(bool blocked) external {
        transfersBlocked = blocked;
    }

    function _update(address from, address to, uint256 value) internal override {
        if (transfersBlocked && from != address(0)) revert TransfersBlocked();
        super._update(from, to, value);
    }
}
