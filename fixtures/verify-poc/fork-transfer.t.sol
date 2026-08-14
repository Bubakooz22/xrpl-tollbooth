// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";

interface IERC20 {
    function balanceOf(address a) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
}

// Fixture 2 \u2014 fork state exercised via vm.prank.
// Verifies: --fork-url wiring + Foundry cheatcode surface + our grader
// under a real forked-block execution. Uses USDC because its supply is
// concentrated across large custodial addresses that virtually always
// hold non-zero balances at any recent block.
//
// We do NOT pin a specific whale address because balances shift over
// time. Instead, we `deal` USDC to a synthetic address using the
// storage-slot cheatcode, which is deterministic across blocks.
contract ForkTransferTest is Test {
    address constant USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;

    function testForkedDealAndTransfer() public {
        address alice = makeAddr("alice");
        address bob = makeAddr("bob");

        // deal() writes USDC.balanceOf[alice] via storage-slot poking.
        // Works on any recent mainnet block.
        deal(USDC, alice, 1_000_000e6); // 1M USDC

        uint256 aliceBefore = IERC20(USDC).balanceOf(alice);
        assertEq(aliceBefore, 1_000_000e6, "deal should credit alice");

        vm.prank(alice);
        IERC20(USDC).transfer(bob, 250_000e6);

        assertEq(IERC20(USDC).balanceOf(alice), 750_000e6, "alice debited");
        assertEq(IERC20(USDC).balanceOf(bob),   250_000e6, "bob credited");

        emit log_named_uint("alice_final", IERC20(USDC).balanceOf(alice));
        emit log_named_uint("bob_final",   IERC20(USDC).balanceOf(bob));
    }
}
