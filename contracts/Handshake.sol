// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

/// @title Handshake
/// @notice Peer-to-peer swaps on BOT Chain. A maker deposits what they give and names
///         what they want. Anyone (or one named wallet) can accept: they pay the maker
///         and receive the deposit in the same transaction, so neither side trusts the
///         other. The maker can cancel and get the deposit back until it is taken.
/// @dev    address(0) means native BOT. Fee-on-transfer tokens are rejected on both
///         legs so every swap delivers exactly the stated amounts. The fee is taken from
///         the maker's side when a swap completes.
contract Handshake is Ownable2Step, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    enum Status { None, Open, Filled, Cancelled }

    struct Offer {
        address maker;
        uint40 expiry;
        Status status;
        address taker;     // address(0) = anyone may accept
        address give;      // what the maker deposited
        address want;      // what the maker wants back
        uint128 giveAmount;
        uint128 wantAmount;
        address filledBy;
        string note;
    }

    uint16 public constant MAX_FEE_BPS = 100; // 1% hard cap
    uint40 public constant MAX_DURATION = 365 days;

    uint16 public feeBps = 30; // 0.3%
    address public treasury;
    mapping(address => uint256) public feesAccrued;

    uint256 public offerCount;
    mapping(uint256 => Offer) private _offers;
    mapping(address => uint256[]) private _byMaker;

    event OfferCreated(uint256 indexed id, address indexed maker, address indexed taker, address give, uint256 giveAmount, address want, uint256 wantAmount, uint256 expiry);
    event OfferFilled(uint256 indexed id, address indexed maker, address indexed taker, uint256 fee);
    event OfferCancelled(uint256 indexed id);
    event FeesCollected(address indexed token, address indexed treasury, uint256 amount);
    event ConfigUpdated(uint16 feeBps, address treasury);

    error InvalidParams();
    error WrongAmount();
    error NotAvailable();
    error NotAuthorized();
    error NothingToCollect();
    error TransferFailed();

    constructor(address owner_, address treasury_) Ownable(owner_) {
        if (treasury_ == address(0)) revert InvalidParams();
        treasury = treasury_;
    }

    // ------------------------------------------------------------ offers

    /// @notice Post an offer. For native BOT send exactly `giveAmount`; for a token,
    ///         approve `giveAmount` first.
    function create(
        address give,
        uint128 giveAmount,
        address want,
        uint128 wantAmount,
        address taker,
        uint40 expiry,
        string calldata note
    ) external payable nonReentrant whenNotPaused returns (uint256 id) {
        if (
            give == want || giveAmount == 0 || wantAmount == 0 || taker == msg.sender
                || expiry <= block.timestamp || expiry > block.timestamp + MAX_DURATION || bytes(note).length > 140
        ) revert InvalidParams();

        if (give == address(0)) {
            if (msg.value != giveAmount) revert WrongAmount();
        } else {
            if (msg.value != 0) revert WrongAmount();
            _pullExact(give, msg.sender, address(this), giveAmount);
        }

        id = ++offerCount;
        Offer storage o = _offers[id];
        o.maker = msg.sender;
        o.taker = taker;
        o.give = give;
        o.giveAmount = giveAmount;
        o.want = want;
        o.wantAmount = wantAmount;
        o.expiry = expiry;
        o.status = Status.Open;
        o.note = note;
        _byMaker[msg.sender].push(id);

        emit OfferCreated(id, msg.sender, taker, give, giveAmount, want, wantAmount, expiry);
    }

    /// @notice Accept an offer: pay the maker what they want, receive what they gave
    ///         (minus the fee). For native BOT send exactly `wantAmount`; for a token,
    ///         approve `wantAmount` first.
    function fill(uint256 id) external payable nonReentrant whenNotPaused {
        Offer storage o = _offers[id];
        if (o.status != Status.Open || block.timestamp >= o.expiry) revert NotAvailable();
        if (msg.sender == o.maker || (o.taker != address(0) && msg.sender != o.taker)) revert NotAuthorized();

        o.status = Status.Filled;
        o.filledBy = msg.sender;

        // taker -> maker
        if (o.want == address(0)) {
            if (msg.value != o.wantAmount) revert WrongAmount();
            _sendNative(o.maker, o.wantAmount);
        } else {
            if (msg.value != 0) revert WrongAmount();
            _pullExact(o.want, msg.sender, o.maker, o.wantAmount);
        }

        // contract -> taker, minus fee
        uint256 fee = (uint256(o.giveAmount) * feeBps) / 10_000;
        feesAccrued[o.give] += fee;
        _send(o.give, msg.sender, uint256(o.giveAmount) - fee);

        emit OfferFilled(id, o.maker, msg.sender, fee);
    }

    /// @notice Maker takes the offer down and gets the deposit back. Works even when
    ///         paused or after expiry.
    function cancel(uint256 id) external nonReentrant {
        Offer storage o = _offers[id];
        if (msg.sender != o.maker) revert NotAuthorized();
        if (o.status != Status.Open) revert NotAvailable();
        o.status = Status.Cancelled;
        _send(o.give, o.maker, o.giveAmount);
        emit OfferCancelled(id);
    }

    // ------------------------------------------------------------ fees & admin

    function collectFees(address token) external nonReentrant {
        uint256 amount = feesAccrued[token];
        if (amount == 0) revert NothingToCollect();
        feesAccrued[token] = 0;
        _send(token, treasury, amount);
        emit FeesCollected(token, treasury, amount);
    }

    function setConfig(uint16 feeBps_, address treasury_) external onlyOwner {
        if (feeBps_ > MAX_FEE_BPS || treasury_ == address(0)) revert InvalidParams();
        feeBps = feeBps_;
        treasury = treasury_;
        emit ConfigUpdated(feeBps_, treasury_);
    }

    /// @notice Pausing blocks new offers and fills. Cancel always works.
    function pause() external onlyOwner { _pause(); }
    function unpause() external onlyOwner { _unpause(); }

    // ------------------------------------------------------------ views

    function getOffer(uint256 id) external view returns (Offer memory) { return _offers[id]; }
    function offersOf(address maker) external view returns (uint256[] memory) { return _byMaker[maker]; }

    // ------------------------------------------------------------ internals

    function _pullExact(address token, address from, address to, uint256 amount) private {
        uint256 before = IERC20(token).balanceOf(to);
        IERC20(token).safeTransferFrom(from, to, amount);
        if (IERC20(token).balanceOf(to) - before != amount) revert InvalidParams(); // no fee-on-transfer
    }

    function _send(address token, address to, uint256 amount) private {
        if (amount == 0) return;
        if (token == address(0)) _sendNative(to, amount);
        else IERC20(token).safeTransfer(to, amount);
    }

    function _sendNative(address to, uint256 amount) private {
        (bool ok, ) = payable(to).call{value: amount}("");
        if (!ok) revert TransferFailed();
    }
}
