// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";

// Fixture 3 \u2014 expected_result="revert".
// Verifies: our grader flips correctly when a test function is designed
// to fail. The test asserts a false statement so `success=false` inside
// forge's JSON, and our grader should map that to actual="revert".
//
// NOTE: We DO NOT use vm.expectRevert here \u2014 that produces success=true
// (the revert was expected and matched). For a real "the transaction
// reverted" grading path we need the test itself to fail. This is the
// primary way auditors submit "prove this exploit reverts safely today"
// negative-space PoCs.
contract ExpectRevertTest is Test {
    function testShouldFailForRevertGrading() public pure {
        // Assertion that is false at every block \u2014 forge will mark this
        // test as failed, and we treat that as actual="revert".
        assert(1 == 2);
    }
}
