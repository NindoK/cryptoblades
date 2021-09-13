pragma solidity ^0.6.0;
import "@openzeppelin/contracts-upgradeable/proxy/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/math/SafeMath.sol";
import "@openzeppelin/contracts/token/ERC20/SafeERC20.sol";
import "abdk-libraries-solidity/ABDKMath64x64.sol";
import "hardhat/console.sol";
import "./util.sol";
import "./interfaces/IRandoms.sol";
import "./cryptoblades.sol";
import "./characters.sol";
import "./weapons.sol";
import "./shields.sol";
import "./raid1.sol";

contract PvpArena is Initializable, AccessControlUpgradeable {
    using SafeMath for uint256;
    using ABDKMath64x64 for int128;
    using SafeMath for uint8;
    using SafeERC20 for IERC20;

    struct Fighter {
        uint256 characterID;
        uint256 weaponID;
        uint256 shieldID;
        /// @dev amount of skill wagered for this character
        uint256 wager;
        bool useShield;
    }
    struct Duel {
        uint256 attackerID;
        uint256 defenderID;
        uint256 createdAt;
    }

    struct BountyDistribution {
        uint256 winnerReward;
        uint256 loserPayment;
        uint256 rankingPoolTax;
    }

    bytes32 public constant GAME_ADMIN = keccak256("GAME_ADMIN");

    CryptoBlades public game;
    Characters public characters;
    Weapons public weapons;
    Shields public shields;
    IERC20 public skillToken;
    Raid1 public raids;
    IRandoms public randoms;

    uint8 private _rankingsPoolTaxPercent;
    /// @dev how many times the cost of battling must be wagered to enter the arena
    uint8 public wageringFactor;
    /// @dev the base amount wagered per duel in dollars
    int128 private _baseWagerUSD;
    /// @dev how much extra USD is wagered per level tier
    int128 private _tierWagerUSD;
    /// @dev how much of a duel's bounty is sent to the rankings pool
    /// @dev amount of time a character is unattackable
    uint256 public unattackableSeconds;
    /// @dev amount of time an attacker has to make a decision
    uint256 public decisionSeconds;

    /// @dev last time a character was involved in activity that makes it untattackable
    mapping(uint256 => uint256) private _lastActivityByCharacter;
    /// @dev Fighter by characterID
    mapping(uint256 => Fighter) private _fightersByCharacter;
    /// @dev IDs of characters available by tier (1-10, 11-20, etc...)
    mapping(uint8 => uint256[]) private _fightersByTier;
    /// @dev IDs of characters in the arena per player
    mapping(address => uint256[]) private _fightersByPlayer;
    /// @dev Active duel by characterID currently attacking
    mapping(uint256 => Duel) private _duelByAttacker;
    /// @dev characters currently in the arena
    mapping(uint256 => bool) private _charactersInArena;
    /// @dev weapons currently in the arena
    mapping(uint256 => bool) private _weaponsInArena;
    /// @dev shields currently in the arena
    mapping(uint256 => bool) private _shieldsInArena;
    /// @dev earnings earned by player
    mapping(address => uint256) private _rewardsByPlayer;
    /// @dev accumulated rewards per tier
    mapping(uint8 => uint256) private _rankingsPoolByTier;

    event NewDuel(
        uint256 indexed attacker,
        uint256 indexed defender,
        uint256 timestamp
    );
    event DuelFinished(
        uint256 indexed attacker,
        uint256 indexed defender,
        uint256 timestamp,
        uint256 attackerRoll,
        uint256 defenderRoll,
        bool attackerWon
    );

    modifier characterInArena(uint256 characterID) {
        require(
            isCharacterInArena(characterID),
            "Character is not in the arena"
        );
        _;
    }
    modifier isOwnedCharacter(uint256 characterID) {
        require(
            characters.ownerOf(characterID) == msg.sender,
            "Character is not owned by sender"
        );
        _;
    }

    modifier restricted() {
        _restricted();
        _;
    }

    function _restricted() internal view {
        require(hasRole(GAME_ADMIN, msg.sender), "Not game admin");
    }

    modifier enteringArenaChecks(
        uint256 characterID,
        uint256 weaponID,
        uint256 shieldID,
        bool useShield
    ) {
        require(!isCharacterInArena(characterID), "Character already in arena");
        require(!_weaponsInArena[weaponID], "Weapon already in arena");
        require(
            characters.ownerOf(characterID) == msg.sender,
            "Not character owner"
        );
        require(weapons.ownerOf(weaponID) == msg.sender, "Not weapon owner");
        require(!raids.isCharacterRaiding(characterID), "Character is in raid");
        require(!raids.isWeaponRaiding(weaponID), "Weapon is in raid");

        if (useShield) {
            require(
                shields.ownerOf(shieldID) == msg.sender,
                "Not shield owner"
            );
            require(!_shieldsInArena[shieldID], "Shield already in arena");
        }

        _;
    }

    function initialize(
        address gameContract,
        address shieldsContract,
        address raidContract,
        address randomsContract
    ) public initializer {
        __AccessControl_init_unchained();
        _setupRole(DEFAULT_ADMIN_ROLE, msg.sender);

        game = CryptoBlades(gameContract);
        characters = Characters(game.characters());
        weapons = Weapons(game.weapons());
        shields = Shields(shieldsContract);
        skillToken = IERC20(game.skillToken());
        raids = Raid1(raidContract);
        randoms = IRandoms(randomsContract);

        // TODO: Tweak these values, they are placeholders
        wageringFactor = 3;
        _baseWagerUSD = ABDKMath64x64.divu(500, 100); // $5
        _tierWagerUSD = ABDKMath64x64.divu(50, 100); // $0.5
        _rankingsPoolTaxPercent = 15;
        unattackableSeconds = 2 minutes;
        decisionSeconds = 3 minutes;
    }

    /// @notice enter the arena with a character, a weapon and optionally a shield
    function enterArena(
        uint256 characterID,
        uint256 weaponID,
        uint256 shieldID,
        bool useShield
    ) external enteringArenaChecks(characterID, weaponID, shieldID, useShield) {
        uint256 wager = getEntryWager(characterID);
        uint8 tier = getArenaTier(characterID);

        _charactersInArena[characterID] = true;
        _weaponsInArena[weaponID] = true;

        if (useShield) _shieldsInArena[shieldID] = true;

        _fightersByTier[tier].push(characterID);
        _fightersByPlayer[msg.sender].push(characterID);
        _fightersByCharacter[characterID] = Fighter(
            characterID,
            weaponID,
            shieldID,
            wager,
            useShield
        );

        // character starts unattackable
        _updateLastActivityTimestamp(characterID);

        skillToken.transferFrom(msg.sender, address(this), wager);
    }

    /// @dev attempts to find an opponent for a character. If a battle is still pending, it charges a penalty and re-rolls the opponent
    function requestOpponent(uint256 characterID)
        external
        characterInArena(characterID)
        isOwnedCharacter(characterID)
    {
        _assignOpponent(characterID);
    }

    /// @dev requests a new opponent for a fee
    function reRollOpponent(uint256 characterID)
        external
        characterInArena(characterID)
        isOwnedCharacter(characterID)
    {
        require(isCharacterDueling(characterID), "Character is not dueling");

        _assignOpponent(characterID);

        skillToken.transferFrom(
            msg.sender,
            address(this),
            getDuelCost(characterID).div(4)
        );
    }

    /// @dev performs a given character's duel against its opponent
    function performDuel(uint256 attackerID) external {
        // TODO: implement (not final signature)
        // - [x] verify opponent is assigned
        // - [x] verify character is within decision seconds
        // - [x] calculate winner
        // - [x] consider elemental bonus
        // - [ ] update isCharacterDueling
        // - [x] add tracking for earnings
        // - [x] distribute earnings
        // - [ ] update both characters' last activity timestamp
        // - [x] remove loser from arena if wager is zero
        require(
            isAttackerWithinDecisionTime(attackerID),
            "Decision time expired"
        );
        uint256 defenderID = getOpponent(attackerID);
        uint8 defenderTrait = characters.getTrait(defenderID);
        uint8 attackerTrait = characters.getTrait(attackerID);

        uint24 attackerRoll = _getCharacterPowerRoll(
            attackerID,
            defenderTrait,
            true
        );
        uint24 defenderRoll = _getCharacterPowerRoll(
            defenderID,
            attackerTrait,
            false
        );

        uint256 winnerID = attackerRoll >= defenderRoll
            ? attackerID
            : defenderID;
        uint256 loserID = attackerRoll >= defenderRoll
            ? defenderID
            : attackerID;
        address winner = characters.ownerOf(winnerID);

        emit DuelFinished(
            attackerID,
            defenderID,
            block.timestamp,
            attackerRoll,
            defenderRoll,
            attackerRoll >= defenderRoll
        );

        BountyDistribution
            memory bountyDistribution = _getDuelBountyDistribution(attackerID);

        _rewardsByPlayer[winner] = _rewardsByPlayer[winner].add(
            bountyDistribution.winnerReward
        );
        _fightersByCharacter[loserID].wager = _fightersByCharacter[loserID]
            .wager
            .sub(bountyDistribution.loserPayment);

        if (_fightersByCharacter[loserID].wager == 0) {
            _removeCharacterFromArena(loserID);
        }

        // add to the rankings pool
        _rankingsPoolByTier[getArenaTier(attackerID)] = _rankingsPoolByTier[
            getArenaTier(attackerID)
        ].add(bountyDistribution.rankingPoolTax);
    }

    /// @dev withdraws a character and its items from the arena.
    /// if the character is in a battle, a penalty is charged
    function withdrawFromArena(uint256 characterID)
        external
        isOwnedCharacter(characterID)
    {
        Fighter storage fighter = _fightersByCharacter[characterID];
        uint256 wager = fighter.wager;
        _removeCharacterFromArena(characterID);
        if (isCharacterDueling(characterID)) {
            skillToken.safeTransfer(msg.sender, wager.sub(wager.div(4)));
        } else {
            skillToken.safeTransfer(msg.sender, wager);
        }
    }

    /// @dev returns the SKILL amounts distributed to the winner and the ranking pool
    function _getDuelBountyDistribution(uint256 attackerID)
        private
        view
        returns (BountyDistribution memory bountyDistribution)
    {
        uint256 duelCost = getDuelCost(attackerID);
        uint256 bounty = duelCost.mul(2);
        uint256 poolTax = _rankingsPoolTaxPercent.mul(bounty).div(100);

        uint256 reward = bounty.sub(poolTax).sub(duelCost);

        return BountyDistribution(reward, duelCost, poolTax);
    }

    /// @dev gets the player's unclaimed rewards
    function getMyRewards() public view returns (uint256) {
        return _rewardsByPlayer[msg.sender];
    }

    function getRankingRewardsPool(uint8 tier) public view returns (uint256) {
        return _rankingsPoolByTier[tier];
    }

    /// @dev gets the amount of SKILL that is risked per duel
    function getDuelCost(uint256 characterID) public view returns (uint256) {
        int128 tierExtra = ABDKMath64x64
            .divu(getArenaTier(characterID).mul(100), 100)
            .mul(_tierWagerUSD);

        return game.usdToSkill(_baseWagerUSD.add(tierExtra));
    }

    /// @notice gets the amount of SKILL required to enter the arena
    /// @param characterID the id of the character entering the arena
    function getEntryWager(uint256 characterID) public view returns (uint256) {
        return getDuelCost(characterID).mul(wageringFactor);
    }

    /// @dev gets the arena tier of a character (tiers are 1-10, 11-20, etc...)
    function getArenaTier(uint256 characterID) public view returns (uint8) {
        uint256 level = characters.getLevel(characterID);
        return uint8(level.div(10));
    }

    /// @dev gets IDs of the sender's characters currently in the arena
    function getMyParticipatingCharacters()
        public
        view
        returns (uint256[] memory)
    {
        return _fightersByPlayer[msg.sender];
    }

    /// @dev returns the IDs of the sender's weapons currently in the arena
    function getMyParticipatingWeapons()
        external
        view
        returns (uint256[] memory)
    {
        Fighter[] memory fighters = _getMyFighters();
        uint256[] memory weaponIDs = new uint256[](fighters.length);

        for (uint256 i = 0; i < fighters.length; i++) {
            weaponIDs[i] = fighters[i].weaponID;
        }

        return weaponIDs;
    }

    /// @dev returns the IDs of the sender's shields currently in the arena
    function getMyParticipatingShields()
        external
        view
        returns (uint256[] memory)
    {
        Fighter[] memory fighters = _getMyFighters();
        uint256 shieldsCount = 0;

        for (uint256 i = 0; i < fighters.length; i++) {
            if (fighters[i].useShield) shieldsCount++;
        }

        uint256[] memory shieldIDs = new uint256[](shieldsCount);
        uint256 shieldIDsIndex = 0;

        for (uint256 i = 0; i < fighters.length; i++) {
            if (fighters[i].useShield) {
                shieldIDs[shieldIDsIndex] = fighters[i].shieldID;
                shieldIDsIndex++;
            }
        }

        return shieldIDs;
    }

    /// @dev checks if a character is in the arena
    function isCharacterInArena(uint256 characterID)
        public
        view
        returns (bool)
    {
        return _charactersInArena[characterID];
    }

    /// @dev checks if a weapon is in the arena
    function isWeaponInArena(uint256 weaponID) public view returns (bool) {
        return _weaponsInArena[weaponID];
    }

    /// @dev checks if a shield is in the arena
    function isShieldInArena(uint256 shieldID) public view returns (bool) {
        return _shieldsInArena[shieldID];
    }

    /// @dev get an attacker's opponent
    function getOpponent(uint256 characterID) public view returns (uint256) {
        return _duelByAttacker[characterID].defenderID;
    }

    /// @dev get amount wagered for a given character
    function getCharacterWager(uint256 characterID)
        public
        view
        returns (uint256)
    {
        return _fightersByCharacter[characterID].wager;
    }

    /// @dev wether or not the character is still in time to start a duel
    function isAttackerWithinDecisionTime(uint256 characterID)
        public
        view
        returns (bool)
    {
        return
            _duelByAttacker[characterID].createdAt.add(decisionSeconds) >
            block.timestamp;
    }

    /// @dev wether or not the character is already in a duel
    /// TODO adjust this formula to use the right checks when the duel struct is ready
    function isCharacterDueling(uint256 characterID)
        public
        view
        returns (bool)
    {
        return isAttackerWithinDecisionTime(characterID);
    }

    /// @dev wether or not a character can appear as someone's opponent
    function isCharacterAttackable(uint256 characterID)
        public
        view
        returns (bool)
    {
        uint256 lastActivity = _lastActivityByCharacter[characterID];

        return lastActivity.add(unattackableSeconds) <= block.timestamp;
    }

    /// @dev updates the last activity timestamp of a character
    function _updateLastActivityTimestamp(uint256 characterID) private {
        _lastActivityByCharacter[characterID] = block.timestamp;
    }

    function _getCharacterPowerRoll(
        uint256 characterID,
        uint8 opponentTrait,
        bool applyTraitBonus
    ) private view returns (uint24) {
        // TODO:
        // - [ ] consider shield
        uint8 trait = characters.getTrait(characterID);
        uint24 basePower = characters.getPower(characterID);
        uint256 weaponID = _fightersByCharacter[characterID].weaponID;
        uint256 seed = randoms.getRandomSeed(msg.sender);

        (
            ,
            int128 weaponMultFight,
            uint24 weaponBonusPower,
            uint8 weaponTrait
        ) = weapons.getFightData(weaponID, trait);

        uint24 traitsCWE = uint24(
            trait |
                (uint24(weaponTrait) << 8) |
                ((opponentTrait & 0xFF000000) >> 8)
        );

        int128 playerTraitBonus = ABDKMath64x64.fromUInt(1);

        if (applyTraitBonus) {
            playerTraitBonus = game.getPlayerTraitBonusAgainst(traitsCWE);
        }
        // FIXME: Should probably calculate on one side only
        uint256 playerFightPower = game.getPlayerPower(
            basePower,
            weaponMultFight,
            weaponBonusPower
        );

        uint256 playerPower = RandomUtil.plusMinus10PercentSeeded(
            playerFightPower,
            seed
        );

        return uint24(playerTraitBonus.mulu(playerPower));
    }

    /// @dev removes a character from the arena's state
    function _removeCharacterFromArena(uint256 characterID) private {
        require(isCharacterInArena(characterID), "Character not in arena");
        Fighter storage fighter = _fightersByCharacter[characterID];

        uint256 weaponID = fighter.weaponID;
        uint256 shieldID = fighter.shieldID;

        delete _fightersByCharacter[characterID];

        uint256[] storage playerFighters = _fightersByPlayer[msg.sender];
        playerFighters[characterID] = playerFighters[playerFighters.length - 1];
        playerFighters.pop();

        uint8 tier = getArenaTier(characterID);

        uint256[] storage tierFighters = _fightersByTier[tier];
        tierFighters[characterID] = tierFighters[tierFighters.length - 1];
        tierFighters.pop();

        _charactersInArena[characterID] = false;
        _weaponsInArena[weaponID] = false;
        _shieldsInArena[shieldID] = false;
    }

    /// @dev attempts to find an opponent for a character.
    function _assignOpponent(uint256 characterID) private {
        uint8 tier = getArenaTier(characterID);

        uint256[] storage fightersInTier = _fightersByTier[tier];

        require(
            fightersInTier.length != 0,
            "No opponents available for this character's level"
        );

        uint256 seed = randoms.getRandomSeed(msg.sender);
        uint256 randomIndex = RandomUtil.randomSeededMinMax(
            0,
            fightersInTier.length - 1,
            seed
        );

        uint256 opponentID;
        bool foundOpponent = false;

        // run through fighters from a random starting point until we find one or none are available
        for (uint256 i = 0; i < fightersInTier.length; i++) {
            uint256 index = (randomIndex + i) % fightersInTier.length;
            uint256 candidateID = fightersInTier[index];
            if (candidateID == characterID) continue;
            if (!isCharacterAttackable(candidateID)) continue;
            foundOpponent = true;
            opponentID = candidateID;
            break;
        }

        require(foundOpponent, "No opponent found");

        _duelByAttacker[characterID] = Duel(
            characterID,
            opponentID,
            block.timestamp
        );

        // mark both characters as unattackable
        _lastActivityByCharacter[characterID] = block.timestamp;
        _lastActivityByCharacter[opponentID] = block.timestamp;

        emit NewDuel(characterID, opponentID, block.timestamp);
    }

    /// @dev returns the senders fighters in the arena
    function _getMyFighters() internal view returns (Fighter[] memory) {
        uint256[] memory characterIDs = getMyParticipatingCharacters();
        Fighter[] memory fighters = new Fighter[](characterIDs.length);

        for (uint256 i = 0; i < characterIDs.length; i++) {
            fighters[i] = _fightersByCharacter[characterIDs[i]];
        }

        return fighters;
    }
}
