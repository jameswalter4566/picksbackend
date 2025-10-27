// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {OutcomeShare} from "./OutcomeShare.sol";

contract PredictionMarket is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum Outcome { Pending, Yes, No, Invalid }

    IERC20 public immutable asset;       // WBNB/FDUSD/USDT
    uint64 public immutable endTime;     // market end
    uint64 public immutable cutoffTime;  // last time buys allowed
    uint16 public feeBps;                // 300 = 3%
    address public feeRecipient;         // resolver/treasury

    uint256 public vaultYes;
    uint256 public vaultNo;

    OutcomeShare public yesShare;
    OutcomeShare public noShare;

    Outcome public finalOutcome;

    event Bought(address indexed user, bool isYes, uint256 amountIn, uint256 sharesMinted, uint256 fee);
    event Resolved(Outcome outcome);
    event Claimed(address indexed user, uint256 burnedShares, uint256 paidOut);

    constructor(
        address _owner,
        address _asset,
        uint64 _endTime,
        uint64 _cutoffTime,
        uint16 _feeBps,
        address _feeRecipient,
        string memory namePrefix
    ) {
        require(_endTime > block.timestamp, "end in past");
        require(_cutoffTime < _endTime, "cutoff >= end");
        _transferOwnership(_owner);
        asset = IERC20(_asset);
        endTime = _endTime;
        cutoffTime = _cutoffTime;
        feeBps = _feeBps;
        feeRecipient = _feeRecipient;

        yesShare = new OutcomeShare(string(abi.encodePacked(namePrefix, " Yes Share")), "YES", address(this));
        noShare  = new OutcomeShare(string(abi.encodePacked(namePrefix, " No Share")),  "NO",  address(this));
    }

    function buyYes(uint256 amount) external nonReentrant { _buy(true, amount); }
    function buyNo(uint256 amount)  external nonReentrant { _buy(false, amount); }

    function _buy(bool isYes, uint256 amount) internal {
        require(block.timestamp < cutoffTime, "trading closed");
        require(finalOutcome == Outcome.Pending, "resolved");
        require(amount > 0, "zero");

        asset.safeTransferFrom(msg.sender, address(this), amount);
        uint256 fee = (amount * feeBps) / 10_000;
        if (fee > 0) asset.safeTransfer(feeRecipient, fee);
        uint256 net = amount - fee;

        if (isYes) { vaultYes += net; yesShare.mint(msg.sender, net); }
        else { vaultNo += net; noShare.mint(msg.sender, net); }

        emit Bought(msg.sender, isYes, amount, net, fee);
    }

    function resolve(Outcome outcome) external onlyOwner {
        require(finalOutcome == Outcome.Pending, "done");
        require(block.timestamp >= endTime, "not ended");
        require(outcome == Outcome.Yes || outcome == Outcome.No || outcome == Outcome.Invalid, "bad");
        finalOutcome = outcome;
        emit Resolved(outcome);
    }

    function claim() external nonReentrant {
        require(finalOutcome != Outcome.Pending, "not resolved");
        if (finalOutcome == Outcome.Invalid) {
            uint256 a = yesShare.balanceOf(msg.sender);
            uint256 b = noShare.balanceOf(msg.sender);
            uint256 refund = a + b;
            if (a > 0) yesShare.burn(msg.sender, a);
            if (b > 0) noShare.burn(msg.sender, b);
            if (refund > 0) asset.safeTransfer(msg.sender, refund);
            emit Claimed(msg.sender, a + b, refund);
            return;
        }
        bool yesWon = (finalOutcome == Outcome.Yes);
        OutcomeShare winShare  = yesWon ? yesShare : noShare;
        uint256 winVault  = yesWon ? vaultYes : vaultNo;
        uint256 loseVault = yesWon ? vaultNo  : vaultYes;
        uint256 userShares = winShare.balanceOf(msg.sender);
        require(userShares > 0, "no shares");
        uint256 totalWin = winShare.totalSupply();
        winShare.burn(msg.sender, userShares);
        uint256 payout = ((winVault + loseVault) * userShares) / totalWin;
        asset.safeTransfer(msg.sender, payout);
        emit Claimed(msg.sender, userShares, payout);
    }

    function getTotals() external view returns (uint256 _vaultYes, uint256 _vaultNo, uint256 _sYes, uint256 _sNo) {
        return (vaultYes, vaultNo, yesShare.totalSupply(), noShare.totalSupply());
    }
}

