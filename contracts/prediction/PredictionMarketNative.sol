// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {OutcomeShare} from "./OutcomeShare.sol";

/// @title PredictionMarketNative
/// @notice Minimal BNB-native market that wraps incoming value into YES/NO vault balances
contract PredictionMarketNative is Ownable, ReentrancyGuard {
    enum Outcome { Pending, Yes, No, Invalid }

    uint64 public immutable endTime;
    uint64 public immutable cutoffTime;
    uint16 public feeBps;
    address public feeRecipient;
    address public creatorFeeRecipient;
    uint16 public creatorFeeSplitBps;

    uint256 public vaultYes;
    uint256 public vaultNo;

    OutcomeShare public yesShare;
    OutcomeShare public noShare;

    Outcome public finalOutcome;

    event Bought(address indexed user, bool isYes, uint256 amountIn, uint256 sharesMinted, uint256 fee);
    event Resolved(Outcome outcome);
    event ForceResolved(Outcome outcome);
    event Claimed(address indexed user, uint256 burnedShares, uint256 paidOut);

    constructor(
        address _owner,
        uint64 _endTime,
        uint64 _cutoffTime,
        uint16 _feeBps,
        address _feeRecipient,
        address _creatorFeeRecipient,
        uint16 _creatorFeeSplitBps,
        string memory namePrefix
    ) Ownable(_owner) {
        require(_endTime > block.timestamp, "end in past");
        require(_cutoffTime < _endTime, "cutoff >= end");
        endTime = _endTime;
        cutoffTime = _cutoffTime;
        feeBps = _feeBps;
        feeRecipient = _feeRecipient;
        require(_creatorFeeSplitBps <= 10_000, "split too large");
        if (_creatorFeeRecipient != address(0) && _creatorFeeSplitBps > 0) {
            creatorFeeRecipient = _creatorFeeRecipient;
            creatorFeeSplitBps = _creatorFeeSplitBps;
        }

        yesShare = new OutcomeShare(
            string(abi.encodePacked(namePrefix, " Yes Share")),
            "YES",
            address(this)
        );
        noShare = new OutcomeShare(
            string(abi.encodePacked(namePrefix, " No Share")),
            "NO",
            address(this)
        );
    }

    receive() external payable {}

    function buyYesWithBNB() external payable nonReentrant { _buy(true); }
    function buyNoWithBNB() external payable nonReentrant { _buy(false); }

    function _buy(bool isYes) internal {
        require(block.timestamp < cutoffTime, "trading closed");
        require(finalOutcome == Outcome.Pending, "resolved");
        uint256 amount = msg.value;
        require(amount > 0, "zero");

        uint256 fee = (amount * feeBps) / 10_000;
        uint256 net = amount - fee;
        if (fee > 0) {
            if (creatorFeeRecipient != address(0) && creatorFeeSplitBps > 0) {
                // creatorFeeSplitBps is denominated in trade basis points, not fee basis points,
                // so convert by applying it to the gross amount and cap to the total fee collected.
                uint256 creatorCut = (amount * creatorFeeSplitBps) / 10_000;
                if (creatorCut > fee) creatorCut = fee;
                uint256 platformCut = fee - creatorCut;
                if (creatorCut > 0) _sendValue(creatorFeeRecipient, creatorCut);
                if (platformCut > 0) _sendValue(feeRecipient, platformCut);
            } else {
                _sendValue(feeRecipient, fee);
            }
        }

        if (isYes) {
            vaultYes += net;
            yesShare.mint(msg.sender, net);
        } else {
            vaultNo += net;
            noShare.mint(msg.sender, net);
        }

        emit Bought(msg.sender, isYes, amount, net, fee);
    }

    function resolve(Outcome outcome) external onlyOwner {
        _resolve(outcome, false);
    }

    function forceResolve(Outcome outcome) external onlyOwner {
        _resolve(outcome, true);
    }

    function _resolve(Outcome outcome, bool force) internal {
        require(finalOutcome == Outcome.Pending, "done");
        if (!force) {
            require(block.timestamp >= endTime, "not ended");
        }
        require(
            outcome == Outcome.Yes || outcome == Outcome.No || outcome == Outcome.Invalid,
            "bad"
        );
        finalOutcome = outcome;
        if (force) {
            emit ForceResolved(outcome);
        }
        emit Resolved(outcome);
    }

    function claim() external nonReentrant {
        _claim(msg.sender);
    }

    function claimFor(address user) external onlyOwner nonReentrant {
        require(user != address(0), "bad user");
        _claim(user);
    }

    function _claim(address user) internal {
        require(finalOutcome != Outcome.Pending, "not resolved");
        if (finalOutcome == Outcome.Invalid) {
            uint256 a = yesShare.balanceOf(user);
            uint256 b = noShare.balanceOf(user);
            uint256 refund = a + b;
            if (a > 0) yesShare.burn(user, a);
            if (b > 0) noShare.burn(user, b);
            if (refund > 0) _sendValue(user, refund);
            emit Claimed(user, a + b, refund);
            return;
        }

        bool yesWon = (finalOutcome == Outcome.Yes);
        OutcomeShare winShare = yesWon ? yesShare : noShare;
        uint256 winVault = yesWon ? vaultYes : vaultNo;
        uint256 loseVault = yesWon ? vaultNo : vaultYes;

        uint256 userShares = winShare.balanceOf(user);
        require(userShares > 0, "no shares");

        uint256 totalWin = winShare.totalSupply();
        winShare.burn(user, userShares);

        uint256 payout = ((winVault + loseVault) * userShares) / totalWin;
        _sendValue(user, payout);

        emit Claimed(user, userShares, payout);
    }

    function getTotals()
        external
        view
        returns (uint256 _vaultYes, uint256 _vaultNo, uint256 _sYes, uint256 _sNo)
    {
        return (vaultYes, vaultNo, yesShare.totalSupply(), noShare.totalSupply());
    }

    function _sendValue(address to, uint256 amount) internal {
        if (amount == 0) return;
        (bool ok, ) = payable(to).call{value: amount}("");
        require(ok, "send failed");
    }
}
