// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";

// Fixture 1 \u2014 baseline pass.
// Verifies: sandbox + forge-std wiring + JSON parser + grader for the
// expected_result="pass" happy path. No fork state required.
contract SimplePassTest is Test {
    function testAlwaysPasses() public {
        uint256 x = 1 + 1;
        assertEq(x, 2, "1 + 1 should equal 2");
        emit log_named_uint("x", x);
    }
}
