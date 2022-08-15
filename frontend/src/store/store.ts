import Vue from 'vue';
import Vuex from 'vuex';
import Web3 from 'web3';
import _, {isUndefined} from 'lodash';
import {bnMinimum, currentChainSupportsPvP, currentChainSupportsQuests, gasUsedToBnb, toBN} from '@/utils/common';

import {getConfigValue, setUpContracts} from '@/contracts';

import {characterFromContract, junkFromContract, shieldFromContract, targetFromContract, trinketFromContract, weaponFromContract} from '@/contract-models';

import {CharacterPower, Contract, isStakeType, IState, IWeb3EventSubscription, StakeType} from '@/interfaces';
import {getCharacterNameFromSeed} from '@/character-name';
import {approveFee, approveFeeDynamic, approveFeeFixed, getFeeInSkillFromUsd} from '@/contract-call-utils';

import {burningManager as featureFlagBurningManager} from '@/feature-flags';
import {ERC20, IERC721, INftStakingRewards, IStakingRewards} from '@/../../build/abi-interfaces';
import {stakeTypeThatCanHaveUnclaimedRewardsStakedTo} from '@/stake-types';
import {Nft} from '@/interfaces/Nft';
import {getWeaponNameFromSeed} from '@/weapon-name';
import axios from 'axios';
import {abi as erc20Abi} from '@/../../build/contracts/ERC20.json';
import {abi as erc721Abi} from '@/../../build/contracts/IERC721.json';
import BigNumber from 'bignumber.js';
import bridge from './bridge';
import pvp from './pvp';
import quests from './quests';
import raid from './raid';
import staking from './staking';
import land from './land';
import treasury from './treasury';
import specialWeaponsManager from './specialWeaponsManager';

const transakAPIURL = process.env.VUE_APP_TRANSAK_API_URL || 'https://staging-global.transak.com';
const transakAPIKey = process.env.VUE_APP_TRANSAK_API_KEY || '90167697-74a7-45f3-89da-c24d32b9606c';

const defaultCallOptions = (state: IState) => ({ from: state.defaultAccount });

interface SetEventSubscriptionsPayload {
  eventSubscriptions: () => IWeb3EventSubscription[];
}

type StakingRewardsAlias = Contract<IStakingRewards> | null;
type NftStakingRewardsAlias = Contract<INftStakingRewards> | null;

export function getGasPrice() {
  const gasPrice: string = getConfigValue('gasPrice');
  if(gasPrice) {
    return Web3.utils.toWei(gasPrice, 'gwei');
  } else return '';
}

type WaxBridgeDetailsPayload = Pick<
IState, 'waxBridgeWithdrawableBnb' | 'waxBridgeRemainingWithdrawableBnbDuringPeriod' | 'waxBridgeTimeUntilLimitExpires'
>;

Vue.use(Vuex);

export default new Vuex.Store<IState>({
  modules:{
    bridge,
    pvp,
    quests,
    raid,
    staking,
    land,
    treasury,
    specialWeaponsManager
  },
  state: {
    web3: new Web3(),
    contracts: null!,
    eventSubscriptions: () => [],

    accounts: [],
    defaultAccount: null,
    currentNetworkId: null,
    skillPriceInUsd: 0,

    fightGasOffset: '0',
    fightBaseline: '0',

    skillBalance: '0',
    skillRewards: '0',
    maxRewardsClaimTax: '0',
    rewardsClaimTax: '0',
    xpRewards: {},
    inGameOnlyFunds: '0',
    directStakeBonusPercent: 10,
    ownedCharacterIds: [],
    ownedGarrisonCharacterIds: [],
    ownedWeaponIds: [],
    ownedShieldIds: [],
    ownedTrinketIds: [],
    ownedJunkIds: [],
    ownedKeyLootboxIds: [],
    maxStamina: 0,
    currentCharacterId: null,
    ownedDust: [],
    currentChainSupportsPvP: false,
    currentChainSupportsQuests: false,
    hasAdminAccess: false,
    hasMinterAccess: false,

    characters: {},
    garrisonCharacters: {},
    characterStaminas: {},
    characterPowers: {},
    characterIsInArena: {},
    characterRenames: {},
    characterCosmetics: {},
    weapons: {},
    currentWeaponId: null,
    currentNftType: null,
    currentNftId: null,
    weaponDurabilities: {},
    weaponRenames: {},
    maxDurability: 0,
    isInCombat: false,
    weaponCosmetics: {},
    isCharacterViewExpanded: localStorage.getItem('isCharacterViewExpanded') ? localStorage.getItem('isCharacterViewExpanded') === 'true' : true,

    targetsByCharacterIdAndWeaponId: {},

    shields: {},
    trinkets: {},
    junk: {},
    keyboxes: {},
    currentShieldId: null,
    nfts: {},

    waxBridgeWithdrawableBnb: '0',
    waxBridgeRemainingWithdrawableBnbDuringPeriod: '0',
    waxBridgeTimeUntilLimitExpires: 0,
  },

  getters: {
    getWeb3(state: IState) {
      return state.web3;
    },
    contracts(state: IState) {
      // our root component prevents the app from being active if contracts
      // are not set up, so we never need to worry about it being null anywhere else
      return _.isFunction(state.contracts) ? state.contracts() : null!;
    },

    getTargetsByCharacterIdAndWeaponId(state: IState) {
      return (characterId: number, weaponId: number) => {
        const targetsByWeaponId = state.targetsByCharacterIdAndWeaponId[characterId];
        if (!targetsByWeaponId) return [];

        return targetsByWeaponId[weaponId] ?? [];
      };
    },

    getCharacterName(state: IState) {
      return (characterId: number) => {
        if(state.characterRenames[characterId] !== undefined){
          return state.characterRenames[characterId];
        }
        return getCharacterNameFromSeed(characterId);
      };
    },

    getCharacterStamina(state: IState) {
      return (characterId: number) => {
        return state.characterStaminas[characterId];
      };
    },

    getCharacterPower(state: IState) {
      return (characterId: number) => {
        return state.characterPowers[characterId];
      };
    },

    getCharacterIsInArena(state: IState) {
      return (characterId: number) => {
        return state.characterIsInArena[characterId];
      };
    },

    getCharacterRename(state: IState) {
      return (characterId: number) => {
        return state.characterRenames[characterId];
      };
    },

    getCharacterCosmetic(state: IState) {
      return (characterId: number) => {
        return state.characterCosmetics[characterId];
      };
    },

    getCharacterUnclaimedXp(state: IState) {
      return (characterId: number) => {
        return state.xpRewards[characterId];
      };
    },

    getWeaponDurability(state: IState) {
      return (weaponId: number) => {
        return state.weaponDurabilities[weaponId];
      };
    },
    getWeaponRename(state: IState) {
      return (weaponId: number) => {
        return state.weaponRenames[weaponId];
      };
    },
    getWeaponName(state: IState) {
      return (weaponId: number, stars: number) => {
        if(state.weaponRenames[weaponId] !== undefined) {
          return state.weaponRenames[weaponId];
        }

        return getWeaponNameFromSeed(weaponId, stars);
      };
    },
    getWeaponCosmetic(state: IState) {
      return (weaponId: number) => {
        if(state.weaponCosmetics[weaponId] !== undefined) {
          return state.weaponCosmetics[weaponId];
        }

        return 0;
      };
    },
    getExchangeUrl() {
      return getConfigValue('exchangeUrl');
    },
    getExchangeTransakUrl() {
      const currencyNetwork = getConfigValue('currencyNetwork') || 'BNB';
      const currencyDefault = getConfigValue('currency') || 'BNB';
      const currencyList = getConfigValue('currencyTransak') || 'BNB,BUSD';

      const urlCC = 'defaultCryptoCurrency=' + currencyDefault;
      const urlCCL = 'cryptoCurrencyList=' + currencyList;

      //Transak is not available for Huobi & OKEX
      if(currencyNetwork === 'Huobi' || currencyNetwork === 'OKEx') return;

      return transakAPIURL + '/?apiKey=' + transakAPIKey + '&' + urlCC + '&' + urlCCL;
    },
    ownCharacters(state, getters) {
      return getters.charactersWithIds(state.ownedCharacterIds);
    },

    ownGarrisonCharacters(state, getters) {
      return getters.garrisonCharactersWithIds(state.ownedGarrisonCharacterIds);
    },

    charactersWithIds(state) {
      return (characterIds: (string | number)[]) => {
        const characters = characterIds.map((id) => state.characters[+id]);
        if (characters.some((w) => w === null)) return [];
        return characters.filter(Boolean);
      };
    },

    garrisonCharactersWithIds(state) {
      return (characterIds: (string | number)[]) => {
        const characters = characterIds.map((id) => state.garrisonCharacters[+id]);
        if (characters.some((w) => w === null)) return [];
        return characters.filter(Boolean);
      };
    },

    getPowerfulDust(state) {
      return () => {
        return state.ownedDust[2];
      };
    },

    getLesserDust(state) {
      return () => {
        return state.ownedDust[0];
      };
    },

    getGreaterDust(state) {
      return () => {
        return state.ownedDust[1];
      };
    },

    getCurrentChainSupportsPvP(state) {
      return state.currentChainSupportsPvP;
    },

    getCurrentChainSupportsQuests(state) {
      return state.currentChainSupportsQuests;
    },

    getHasAdminAccess(state) {
      return state.hasAdminAccess;
    },

    getHasMinterAccess(state) {
      return state.hasMinterAccess;
    },

    ownWeapons(state, getters) {
      return getters.weaponsWithIds(state.ownedWeaponIds);
    },

    weaponsWithIds(state) {
      return (weaponIds: (string | number)[]) => {
        const weapons = weaponIds.map(id => state.weapons[+id]);
        if (weapons.some((w) => w === null)) return [];
        return weapons;
      };
    },

    shieldsWithIds(state) {
      return (shieldIds: (string | number)[]) => {
        const shields = shieldIds.map(id => {
          const shieldNft = state.shields[+id] as Nft;
          if(!shieldNft) {
            return;
          }
          shieldNft.type = 'shield';
          return shieldNft;
        });
        if (shields.some((s) => s === null)) return [];
        return shields;
      };
    },

    nftsCount(state) {
      let count = 0;
      // add count of various nft types here
      count += state.ownedShieldIds.length;
      count += state.ownedTrinketIds.length;
      count += state.ownedJunkIds.length;
      count += state.ownedKeyLootboxIds.length;
      return count;
    },

    nftsWithIdType(state) {
      return (nftIdTypes: { type: string, id: string | number }[]) => {
        const nfts = nftIdTypes.map((idType) => {
          const nft = state.nfts[idType.type] && state.nfts[idType.type][+(idType.id)];
          if(!nft) {
            return;
          }
          nft.type = idType.type;
          nft.id = idType.id;
          return nft;
        });

        if (nfts.some((t) => t === null)) return [];
        return nfts;
      };
    },

    currentWeapon(state) {
      if (state.currentWeaponId === null) return null;

      return state.weapons[state.currentWeaponId];
    },

    currentCharacter(state) {
      if (state.currentCharacterId === null) return null;

      return state.characters[state.currentCharacterId];
    },

    currentCharacterStamina(state) {
      return state.currentCharacterId === null ? 0 : state.characterStaminas[state.currentCharacterId];
    },

    timeUntilCurrentCharacterHasMaxStamina(state, getters) {
      return getters.timeUntilCharacterHasMaxStamina(state.currentCharacterId);
    },

    timeUntilCharacterHasMaxStamina(state, getters) {
      return (id: number) => {
        const currentStamina = getters.getCharacterStamina(id);

        if (!currentStamina && currentStamina !== 0) {
          return '';
        }

        const date = new Date();

        if (state.maxStamina !== currentStamina) {
          date.setTime(date.getTime() + ((state.maxStamina - currentStamina) * (5 * 60000)));
        }

        return(`${
          (date.getMonth()+1).toString().padStart(2, '0')}/${
          date.getDate().toString().padStart(2, '0')}/${
          date.getFullYear().toString().padStart(4, '0')} ${
          date.getHours().toString().padStart(2, '0')}:${
          date.getMinutes().toString().padStart(2, '0')}:${
          date.getSeconds().toString().padStart(2, '0')}`
        );
      };
    },

    timeUntilWeaponHasMaxDurability(state, getters) {
      return (id: number) => {
        const currentDurability = getters.getWeaponDurability(id);
        if (currentDurability === null || currentDurability === undefined) {
          return '';
        }
        const date = new Date();

        if (state.maxDurability !== currentDurability) {
          date.setTime(date.getTime() + ((state.maxDurability - currentDurability) * (50 * 60000)));
        }

        return(`${
          (date.getMonth()+1).toString().padStart(2, '0')}/${
          date.getDate().toString().padStart(2, '0')}/${
          date.getFullYear().toString().padStart(4, '0')} ${
          date.getHours().toString().padStart(2, '0')}:${
          date.getMinutes().toString().padStart(2, '0')}:${
          date.getSeconds().toString().padStart(2, '0')}`
        );
      };
    },

    allStaminas(state) {
      return state.characterStaminas;
    },

    maxRewardsClaimTaxAsFactorBN(state) {
      return toBN(state.maxRewardsClaimTax).dividedBy(toBN(2).exponentiatedBy(64));
    },

    rewardsClaimTaxAsFactorBN(state) {
      return toBN(state.rewardsClaimTax).dividedBy(toBN(2).exponentiatedBy(64));
    },

    fightGasOffset(state) {
      return state.fightGasOffset;
    },

    fightBaseline(state) {
      return state.fightBaseline;
    },

    getIsInCombat(state: IState): boolean {
      return state.isInCombat;
    },

    getIsCharacterViewExpanded(state: IState): boolean {
      return state.isCharacterViewExpanded;
    },

    waxBridgeAmountOfBnbThatCanBeWithdrawnDuringPeriod(state): string {
      return bnMinimum(state.waxBridgeWithdrawableBnb, state.waxBridgeRemainingWithdrawableBnbDuringPeriod).toString();
    },

  },

  mutations: {
    setWeb3(state, web3) {
      state.web3 = web3;
    },
    setNetworkId(state, payload) {
      state.currentNetworkId = payload;
    },

    setAccounts(state: IState, payload) {
      state.accounts = payload.accounts;

      if (payload.accounts.length > 0) {
        state.defaultAccount = payload.accounts[0];
      }
      else {
        state.defaultAccount = null;
      }
    },

    setSkillPriceInUsd(state, payload) {
      state.skillPriceInUsd = payload;
    },

    setContracts(state: IState, payload) {
      state.contracts = payload;
    },

    setEventSubscriptions(state: IState, payload: SetEventSubscriptionsPayload) {
      state.eventSubscriptions = payload.eventSubscriptions;
    },

    updateSkillBalance(state: IState, { skillBalance }) {
      state.skillBalance = skillBalance;
    },

    updateDustBalance(state: IState, { dustBalance }) {
      state.ownedDust = dustBalance;
    },

    updateSkillRewards(state: IState, { skillRewards }: { skillRewards: string }) {
      state.skillRewards = skillRewards;
    },

    updateRewardsClaimTax(
      state,
      { maxRewardsClaimTax, rewardsClaimTax }: { maxRewardsClaimTax: string, rewardsClaimTax: string }
    ) {
      state.maxRewardsClaimTax = maxRewardsClaimTax;
      state.rewardsClaimTax = rewardsClaimTax;
    },

    updateXpRewards(state: IState, { xpRewards }: { xpRewards: { [characterId: string]: string } }) {
      for(const charaId in xpRewards) {
        Vue.set(state.xpRewards, charaId, xpRewards[charaId]);
      }
    },

    updateInGameOnlyFunds(state, { inGameOnlyFunds }: Pick<IState, 'inGameOnlyFunds'>) {
      state.inGameOnlyFunds = inGameOnlyFunds;
    },

    updateFightGasOffset(state: IState, { fightGasOffset }: { fightGasOffset: string }) {
      state.fightGasOffset = fightGasOffset;
    },

    updateFightBaseline(state: IState, { fightBaseline }: { fightBaseline: string }) {
      state.fightBaseline = fightBaseline;
    },

    updateUserDetails(state: IState, payload) {
      const keysToAllow = ['ownedCharacterIds', 'ownedGarrisonCharacterIds', 'ownedWeaponIds', 'maxStamina', 'maxDurability',
        'ownedShieldIds', 'ownedTrinketIds', 'ownedJunkIds', 'ownedKeyLootboxIds'];
      for (const key of keysToAllow) {
        if (Object.hasOwnProperty.call(payload, key)) {
          Vue.set(state, key, payload[key]);
        }
      }

      if (state.ownedCharacterIds.length > 0 &&
        (
          !state.currentCharacterId ||
          !state.ownedCharacterIds.includes(state.currentCharacterId)
        )
      ) {
        state.currentCharacterId = state.ownedCharacterIds[0];
      }
      else if (state.ownedCharacterIds.length === 0) {
        state.currentCharacterId = null;
      }
    },

    setCurrentCharacter(state: IState, characterId: number) {
      state.currentCharacterId = characterId;
    },

    setIsInCombat(state: IState, isInCombat: boolean) {
      state.isInCombat = isInCombat;
    },

    setIsCharacterViewExpanded(state: IState, isExpanded: boolean) {
      state.isCharacterViewExpanded = isExpanded;
      localStorage.setItem('isCharacterViewExpanded', isExpanded ? 'true' : 'false');
    },

    addNewOwnedCharacterId(state: IState, characterId: number) {
      if (!state.ownedCharacterIds.includes(characterId)) {
        state.ownedCharacterIds.push(characterId);
      }
    },

    addNewOwnedGarrisonCharacterId(state: IState, characterId: number) {
      if (!state.ownedGarrisonCharacterIds.includes(characterId)) {
        state.ownedGarrisonCharacterIds.push(characterId);
      }
    },

    addNewOwnedWeaponId(state: IState, weaponId: number) {
      if (!state.ownedWeaponIds.includes(weaponId)) {
        state.ownedWeaponIds.push(weaponId);
      }
    },

    addNewOwnedShieldId(state: IState, shieldId: number) {
      if (!state.ownedShieldIds.includes(shieldId)) {
        state.ownedShieldIds.push(shieldId);
      }
    },

    updateCurrentChainSupportsPvP(state: IState) {
      state.currentChainSupportsPvP = currentChainSupportsPvP();
    },

    updateCurrentChainSupportsQuests(state: IState) {
      state.currentChainSupportsQuests = currentChainSupportsQuests();
    },

    updateHasAdminAccess(state: IState, hasAdminAccess: boolean) {
      state.hasAdminAccess = hasAdminAccess;
    },

    updateHasMinterAccess(state: IState, hasMinterAccess: boolean) {
      state.hasMinterAccess = hasMinterAccess;
    },

    updateCharacter(state: IState, { characterId, character }) {
      Vue.set(state.characters, characterId, character);
    },

    updateGarrisonCharacter(state: IState, { characterId, character }) {
      Vue.set(state.garrisonCharacters, characterId, character);
    },

    updateShield(state: IState, { shieldId, shield }) {
      Vue.set(state.shields, shieldId, shield);
      if(!state.nfts.shield) {
        Vue.set(state.nfts, 'shield', {});
      }
      Vue.set(state.nfts.shield, shieldId, shield);
    },

    updateTrinket(state: IState, { trinketId, trinket }) {
      Vue.set(state.trinkets, trinketId, trinket);
      if(!state.nfts.trinket) {
        Vue.set(state.nfts, 'trinket', {});
      }
      Vue.set(state.nfts.trinket, trinketId, trinket);
    },

    updateJunk(state: IState, { junkId, junk }) {
      Vue.set(state.junk, junkId, junk);
      if(!state.nfts.junk) {
        Vue.set(state.nfts, 'junk', {});
      }
      Vue.set(state.nfts.junk, junkId, junk);
    },

    updateKeyLootbox(state: IState, { keyLootboxId, keybox }) {
      Vue.set(state.keyboxes, keyLootboxId, keybox);
      if(!state.nfts.keybox) {
        Vue.set(state.nfts, 'keybox', {});
      }
      Vue.set(state.nfts.keybox, keyLootboxId, keybox);
    },

    updateWeapon(state: IState, { weaponId, weapon }) {
      Vue.set(state.weapons, weaponId, weapon);
    },

    setCurrentWeapon(state: IState, weaponId: number) {
      state.currentWeaponId = weaponId;
    },

    updateWeaponDurability(state: IState, { weaponId, durability }) {
      Vue.set(state.weaponDurabilities, weaponId, durability);
    },
    updateWeaponRename(state: IState, { weaponId, renameString }) {
      if(renameString !== undefined){
        Vue.set(state.weaponRenames, weaponId, renameString);
      }
    },
    updateWeaponCosmetic(state: IState, { weaponId, weaponCosmetic }) {
      Vue.set(state.weaponCosmetics, weaponId, weaponCosmetic);
    },
    updateCharacterStamina(state: IState, { characterId, stamina }) {
      Vue.set(state.characterStaminas, characterId, stamina);
    },
    updateCharacterPower(state: IState, { characterId, power }) {
      Vue.set(state.characterPowers, characterId, +power);
    },
    updateCharacterInArena(state: IState, { characterId, isCharacterInArena }) {
      Vue.set(state.characterIsInArena, characterId, isCharacterInArena);
    },
    updateCharacterRename(state: IState, { characterId, renameString }) {
      if(renameString !== undefined){
        Vue.set(state.characterRenames, characterId, renameString);
      }
    },
    updateCharacterCosmetic(state: IState, { characterId, characterCosmetic }) {
      Vue.set(state.characterCosmetics, characterId, characterCosmetic);
    },
    updateTargets(state: IState, { characterId, weaponId, targets }) {
      if (!state.targetsByCharacterIdAndWeaponId[characterId]) {
        Vue.set(state.targetsByCharacterIdAndWeaponId, characterId, {});
      }

      Vue.set(state.targetsByCharacterIdAndWeaponId[characterId], weaponId, targets);
    },

    updateWaxBridgeDetails(state, payload: WaxBridgeDetailsPayload) {
      state.waxBridgeWithdrawableBnb = payload.waxBridgeWithdrawableBnb;
      state.waxBridgeRemainingWithdrawableBnbDuringPeriod = payload.waxBridgeRemainingWithdrawableBnbDuringPeriod;
      state.waxBridgeTimeUntilLimitExpires = payload.waxBridgeTimeUntilLimitExpires;
    },

    setCurrentNft(state: IState, payload: {type: string, id: number} ) {
      state.currentNftType = payload.type;
      state.currentNftId = payload.id;
    },
  },

  actions: {
    async fetchUsdSkillValue({state}, payload){
      const { CryptoBlades } = state.contracts();
      if(!CryptoBlades || !state.defaultAccount) return;
      return await CryptoBlades.methods.usdToSkill(payload).call(defaultCallOptions(state));
    },
    async fetchIgoRewardsPerFight({ state }) {
      const { CryptoBlades } = state.contracts();
      if(!CryptoBlades || !state.defaultAccount) return;

      return await CryptoBlades.methods
        .vars(27)
        .call(defaultCallOptions(state));
    },
    async initializeStore({ dispatch }) {
      await dispatch('setUpContracts');
      await dispatch('setUpContractEvents');

      await dispatch('pollAccountsAndNetwork');
      await dispatch('pollSkillPriceInUsd');

      await dispatch('setupCharacterStaminas');
      await dispatch('setupCharacterRenames');
      await dispatch('setupCharacterCosmetics');

      await dispatch('setupWeaponDurabilities');
      await dispatch('setupWeaponRenames');
      await dispatch('setupWeaponCosmetics');

      await dispatch('specialWeaponsManager/fetchSpecialWeaponEvents');
      await dispatch('specialWeaponsManager/fetchSpecialWeaponArts');

      await dispatch('fetchHasAdminAccess');
      await dispatch('fetchHasMinterAccess');
    },

    async pollAccountsAndNetwork({ state, dispatch, commit }) {
      let refreshUserDetails = false;
      const networkId = await state.web3.eth.net.getId();

      if(state.currentNetworkId !== networkId) {
        commit('setNetworkId', networkId);
        refreshUserDetails = true;
      }

      const accounts = await state.web3.eth.getAccounts();

      if (!_.isEqual(state.accounts, accounts)) {
        commit('setAccounts', { accounts });
        refreshUserDetails = true;
      }

      if(refreshUserDetails) {
        await Promise.all([
          dispatch('fetchUserDetails')
        ]);
      }
    },

    async pollSkillPriceInUsd({ state, commit }) {
      const fetchPriceData = async () => {
        const response = await axios.get('https://api.coingecko.com/api/v3/simple/price?ids=cryptoblades,binancecoin&vs_currencies=usd');
        const skillPriceInUsd = response.data?.cryptoblades.usd;
        if (state.skillPriceInUsd !== skillPriceInUsd) {
          commit('setSkillPriceInUsd', skillPriceInUsd);
        }
      };
      await fetchPriceData();
      setInterval(async () => {
        await fetchPriceData();
      }, 30000);
    },



    async setUpContractEvents({ state, dispatch, commit }) {
      const { Characters, Weapons, Garrison, Shields, CryptoBlades } = state.contracts();
      state.eventSubscriptions().forEach(sub => sub.unsubscribe());

      const emptySubsPayload: SetEventSubscriptionsPayload = { eventSubscriptions: () => [] };
      commit('setEventSubscriptions', emptySubsPayload);

      if(!state.defaultAccount || !Characters || !Weapons || !Shields || !CryptoBlades || !Garrison) return;

      const subscriptions: IWeb3EventSubscription[] = [];

      subscriptions.push(
        Characters.events.NewCharacter(
          { filter: { minter: state.defaultAccount } },
          async (err: Error, data: any) => {
            if (err) {
              console.error(err, data);
              return;
            }

            const characterId = data.returnValues.character;

            commit('addNewOwnedCharacterId', characterId);

            await Promise.all([
              dispatch('fetchCharacter', { characterId }),
              dispatch('fetchSkillBalance'),
              dispatch('fetchFightRewardSkill'),
              dispatch('fetchFightRewardXp'),
              dispatch('fetchDustBalance')
            ]);
          })
      );

      subscriptions.push(
        Garrison.events.CharacterReceived(
          { filter: { minter: state.defaultAccount } },
          async (err: Error, data: any) => {
            if (err) {
              console.error(err, data);
              return;
            }

            const characterId = data.returnValues.character;

            commit('addNewOwnedGarrisonCharacterId', characterId);
            //Events.$emit('garrison:characterReceived', { id: characterId });

            await Promise.all([
              dispatch('fetchCharacter', { characterId, inGarrison: true }),
              dispatch('fetchSkillBalance'),
              dispatch('fetchFightRewardSkill'),
              dispatch('fetchFightRewardXp'),
              dispatch('fetchGarrisonCharactersXp'),
              dispatch('fetchDustBalance')
            ]);
          })
      );

      subscriptions.push(
        Weapons.events.NewWeapon({ filter: { minter: state.defaultAccount } }, async (err: Error, data: any) => {
          if (err) {
            console.error(err, data);
            return;
          }

          const weaponId = data.returnValues.weapon;

          commit('addNewOwnedWeaponId', weaponId);

          await Promise.all([
            dispatch('fetchWeapon', weaponId),
            dispatch('fetchSkillBalance'),
          ]);
        })
      );

      subscriptions.push(
        Shields.events.NewShield({ filter: { minter: state.defaultAccount } }, async (err: Error, data: any) => {
          if (err) {
            console.error(err, data);
            return;
          }

          const shieldId = data.returnValues.shield;

          commit('addNewOwnedShieldId', shieldId);

          await Promise.all([
            dispatch('fetchShield', shieldId),
            dispatch('fetchSkillBalance'),
            dispatch('fetchDustBalance')
          ]);
        })
      );

      subscriptions.push(
        CryptoBlades.events.FightOutcome({ filter: { owner: state.defaultAccount } }, async (err: Error, data: any) => {
          if (err) {
            console.error(err, data);
            return;
          }

          await Promise.all([
            dispatch('fetchCharacter', { characterId: data.returnValues.character }),
            dispatch('fetchSkillBalance')
          ]);
        })
      );

      subscriptions.push(
        CryptoBlades.events.InGameOnlyFundsGiven({ filter: { to: state.defaultAccount } }, async (err: Error, data: any) => {
          if (err) {
            console.error(err, data);
            return;
          }

          await Promise.all([
            dispatch('fetchInGameOnlyFunds')
          ]);
        })
      );

      function setupStakingEvents(stakeType: StakeType, StakingRewards: StakingRewardsAlias | NftStakingRewardsAlias) {
        if(!StakingRewards) return;

        subscriptions.push(
          StakingRewards.events.RewardPaid({ filter: { user: state.defaultAccount } }, async (err: Error, data: any) => {
            if (err) {
              console.error(err, data);
              return;
            }

            await dispatch('staking/fetchStakeDetails', { stakeType });
          })
        );

        subscriptions.push(
          StakingRewards.events.RewardAdded(async (err: Error, data: any) => {
            if (err) {
              console.error(err, data);
              return;
            }

            await dispatch('staking/fetchStakeDetails', { stakeType });
          })
        );

        subscriptions.push(
          StakingRewards.events.RewardsDurationUpdated(async (err: Error, data: any) => {
            if (err) {
              console.error(err, data);
              return;
            }

            await dispatch('staking/fetchStakeDetails', { stakeType });
          })
        );
      }

      const staking = state.contracts().staking;
      for(const stakeType of Object.keys(staking).filter(isStakeType)) {
        const stakingEntry = staking[stakeType]!;

        setupStakingEvents(stakeType, stakingEntry.StakingRewards);
      }

      const payload: SetEventSubscriptionsPayload = { eventSubscriptions: () => subscriptions };
      commit('setEventSubscriptions', payload);
    },

    async setUpContracts({state, commit }) {
      const contracts = await setUpContracts(state.web3);
      commit('setContracts', () => contracts);
    },

    async fetchUserDetails({ dispatch }) {
      const promises = [
        dispatch('fetchSkillBalance'),
        dispatch('fetchWaxBridgeDetails'),
        dispatch('fetchDustBalance'),
        dispatch('specialWeaponsManager/fetchShardsSupply')
      ];

      promises.push(dispatch('fetchUserGameDetails'));

      await Promise.all([promises]);
    },

    async fetchUserGameDetails({ state, dispatch, commit }) {
      const [
        ownedCharacterIds,
        ownedGarrisonCharacterIds,
        ownedWeaponIds,
        ownedShieldIds,
        ownedTrinketIds,
        ownedJunkIds,
        ownedKeyLootboxIds,
        maxStamina,
        maxDurability,
      ] = await Promise.all([
        dispatch('getAccountCharacters'),
        dispatch('getAccountGarrisonCharacters'),
        dispatch('getAccountWeapons'),
        state.contracts().Shields!.methods.getOwned().call(defaultCallOptions(state)),
        state.contracts().RaidTrinket!.methods.getOwned().call(defaultCallOptions(state)) || [],
        state.contracts().Junk!.methods.getOwned().call(defaultCallOptions(state)) || [],
        state.contracts().KeyLootbox!.methods.getOwned().call(defaultCallOptions(state)) || [],
        state.contracts().Characters!.methods.maxStamina().call(defaultCallOptions(state)),
        state.contracts().Weapons!.methods.maxDurability().call(defaultCallOptions(state)),
      ]);

      commit('updateUserDetails', {
        ownedCharacterIds: Array.from(ownedCharacterIds),
        ownedGarrisonCharacterIds: Array.from(ownedGarrisonCharacterIds),
        ownedWeaponIds: Array.from(ownedWeaponIds),
        ownedShieldIds: Array.from(ownedShieldIds),
        ownedTrinketIds: Array.from(ownedTrinketIds),
        ownedJunkIds: Array.from(ownedJunkIds),
        ownedKeyLootboxIds: Array.from(ownedKeyLootboxIds),
        maxStamina: parseInt(maxStamina, 10),
        maxDurability: parseInt(maxDurability, 10),
      });

      await Promise.all([
        dispatch('fetchCharacters', ownedCharacterIds),
        dispatch('fetchGarrisonCharacters', ownedGarrisonCharacterIds),
        dispatch('fetchWeapons', ownedWeaponIds),
        dispatch('fetchShields', ownedShieldIds),
        dispatch('fetchTrinkets', ownedTrinketIds),
        dispatch('fetchJunks', ownedJunkIds),
        dispatch('fetchKeyLootboxes', ownedKeyLootboxIds),
        dispatch('fetchFightRewardSkill'),
        dispatch('fetchFightRewardXp'),
        dispatch('fetchGarrisonCharactersXp'),
        dispatch('fetchFightGasOffset'),
        dispatch('fetchFightBaseline'),
      ]);
    },

    async updateWeaponIds({ dispatch, commit }) {
      const ownedWeaponIds = await dispatch('getAccountWeapons');
      commit('updateUserDetails', {
        ownedWeaponIds: Array.from(ownedWeaponIds)
      });
      await dispatch('fetchWeapons', ownedWeaponIds);
    },

    async updateCharacterIds({ dispatch, commit }) {
      const ownedCharacterIds = await dispatch('getAccountCharacters');
      const ownedGarrisonCharacterIds = await dispatch('getAccountGarrisonCharacters');
      commit('updateUserDetails', {
        ownedCharacterIds: Array.from(ownedCharacterIds),
        ownedGarrisonCharacterIds: Array.from(ownedGarrisonCharacterIds)
      });
      await dispatch('fetchCharacters', ownedCharacterIds);
      await dispatch('fetchGarrisonCharacters', ownedGarrisonCharacterIds);
    },

    async updateShieldIds({ state, dispatch, commit }) {
      const ownedShieldIds = await state.contracts().Shields!.methods.getOwned().call(defaultCallOptions(state));
      commit('updateUserDetails', {
        ownedShieldIds: Array.from(ownedShieldIds)
      });
      await dispatch('fetchShields', ownedShieldIds);
    },

    async updateTrinketIds({ state, dispatch, commit }) {
      if(!state.defaultAccount) return;

      const ownedTrinketIds = await state.contracts().RaidTrinket!.methods.getOwned().call(defaultCallOptions(state));
      commit('updateUserDetails', {
        ownedTrinketIds: Array.from(ownedTrinketIds)
      });
      await dispatch('fetchTrinkets', ownedTrinketIds);
    },

    async updateJunkIds({ state, dispatch, commit }) {
      if(!state.defaultAccount) return;

      const ownedJunkIds = await state.contracts().Junk!.methods.getOwned().call(defaultCallOptions(state));
      commit('updateUserDetails', {
        ownedJunkIds: Array.from(ownedJunkIds)
      });
      await dispatch('fetchJunks', ownedJunkIds);
    },

    async updateKeyLootboxIds({ state, dispatch, commit }) {
      if(!state.defaultAccount) return;

      const ownedKeyLootboxIds = await state.contracts().KeyLootbox!.methods.getOwned().call(defaultCallOptions(state));
      commit('updateUserDetails', {
        ownedKeyLootboxIds: Array.from(ownedKeyLootboxIds)
      });
      await dispatch('fetchKeyLootboxes', ownedKeyLootboxIds);
    },

    async fetchSkillBalance({ state, commit, dispatch }) {
      const { defaultAccount } = state;
      if(!defaultAccount) return;

      await Promise.all([
        (async () => {
          const skillBalance = await state.contracts().SkillToken.methods
            .balanceOf(defaultAccount)
            .call(defaultCallOptions(state));

          if(state.skillBalance !== skillBalance) {
            commit('updateSkillBalance', { skillBalance });
          }
        })(),
        dispatch('fetchInGameOnlyFunds'),
        dispatch('staking/fetchStakeDetails', { stakeType: stakeTypeThatCanHaveUnclaimedRewardsStakedTo })
      ]);
    },

    async fetchDustBalance({ state, commit }) {
      const { defaultAccount } = state;
      if(!defaultAccount) return;

      await Promise.all([
        (async () => {
          const dustBalance = await state.contracts().Weapons!.methods
            .getDustSupplies(defaultAccount)
            .call(defaultCallOptions(state));
          commit('updateDustBalance', { dustBalance });
        })(),
      ]);
    },

    async fetchSoulBalance({ state }) {
      const { BurningManager } = state.contracts();
      if(!BurningManager || !state.defaultAccount) return;
      return await BurningManager.methods.userVars(state.defaultAccount, 1).call(defaultCallOptions(state));
    },

    async fetchInGameOnlyFunds({ state, commit }) {
      const { CryptoBlades } = state.contracts();
      if(!CryptoBlades || !state.defaultAccount) return;

      const inGameOnlyFunds = await CryptoBlades.methods
        .inGameOnlyFunds(state.defaultAccount)
        .call(defaultCallOptions(state));

      const payload: Pick<IState, 'inGameOnlyFunds'> = { inGameOnlyFunds };
      commit('updateInGameOnlyFunds', payload);
    },

    async addMoreSkill({ state, dispatch }, skillToAdd: string) {
      await state.contracts().CryptoBlades!.methods.recoverSkill(skillToAdd).send({
        from: state.defaultAccount,
        gasPrice: getGasPrice(),
      });

      await dispatch('fetchSkillBalance');
    },

    async fetchCharacters({ dispatch }, characterIds: (string | number)[]) {
      await Promise.all(characterIds.map(id => dispatch('fetchCharacter', { characterId: id })));
    },

    async fetchGarrisonCharacters({ dispatch }, garrisonCharacterIds: (string | number)[]) {
      await Promise.all(garrisonCharacterIds.map(id => dispatch('fetchCharacter', { characterId: id, inGarrison: true })));
    },

    async fetchCharacter({ state, commit, dispatch }, { characterId, inGarrison = false }: { characterId: string | number, inGarrison: boolean}) {
      const { Characters } = state.contracts();
      if(!Characters) return;

      await Promise.all([
        (async () => {
          const character = characterFromContract(
            characterId,
            await Characters.methods.get('' + characterId).call(defaultCallOptions(state))
          );
          await dispatch('fetchCharacterPower', characterId);
          await dispatch('getIsCharacterInArena', characterId);

          if(!inGarrison) {
            commit('updateCharacter', { characterId, character });
          }
          else {
            commit('updateGarrisonCharacter', { characterId, character });
          }
        })(),
      ]);
    },

    async fetchCharacterPower( {state, commit}, characterId) {
      const { Characters } = state.contracts();
      if(!Characters || !state.defaultAccount) return;
      if(!featureFlagBurningManager) {
        const level = await Characters.methods.getLevel(characterId).call(defaultCallOptions(state));
        const power = CharacterPower(+level);
        commit('updateCharacterPower', { characterId, power });
      }
      else {
        const power = await Characters.methods.getTotalPower(characterId).call(defaultCallOptions(state));
        commit('updateCharacterPower', { characterId, power });
      }
    },

    async fetchWeapons({ dispatch }, weaponIds: (string | number)[]) {
      await Promise.all(weaponIds.map(id => dispatch('fetchWeapon', id)));
    },

    async fetchWeapon({ state, commit, dispatch }, weaponId: string | number) {
      const { Weapons } = state.contracts();
      if(!Weapons) return;

      await Promise.all([
        (async () => {
          const weapon = weaponFromContract(
            weaponId,
            await Weapons.methods.get('' + weaponId).call(defaultCallOptions(state))
          );

          commit('updateWeapon', { weaponId, weapon });
        })(),
      ]);
      dispatch('fetchWeaponDurability', weaponId);
    },
    async getShieldFlag({state}, shieldId){
      const { Shields } = state.contracts();
      if(!Shields || !state.defaultAccount) return;
      return await Shields.methods.getNftVar(shieldId, 2).call(defaultCallOptions(state));
    },
    async fetchShields({ dispatch }, shieldIds: (string | number)[]) {
      await Promise.all(shieldIds.map(id => dispatch('fetchShield', id)));
    },

    async fetchShield({ state, commit }, shieldId: string | number) {
      const { Shields } = state.contracts();
      if(!Shields) return;

      await Promise.all([
        (async () => {
          const shield = shieldFromContract(
            shieldId,
            await Shields.methods.get('' + shieldId).call(defaultCallOptions(state))
          );

          commit('updateShield', { shieldId, shield });
        })(),
      ]);
    },

    async fetchTrinkets({ dispatch }, trinketIds: (string | number)[]) {
      await Promise.all(trinketIds.map(id => dispatch('fetchTrinket', id)));
    },

    async fetchTrinket({ state, commit }, trinketId: string | number) {
      const { RaidTrinket } = state.contracts();
      if(!RaidTrinket) return;

      await Promise.all([
        (async () => {
          const trinket = trinketFromContract(
            trinketId,
            await RaidTrinket.methods.get('' + trinketId).call(defaultCallOptions(state))
          );

          commit('updateTrinket', { trinketId, trinket });
        })(),
      ]);
    },

    async fetchJunks({ dispatch }, junkIds: (string | number)[]) {
      await Promise.all(junkIds.map(id => dispatch('fetchJunk', id)));
    },

    async fetchJunk({ state, commit }, junkId: string | number) {
      const { Junk } = state.contracts();
      if(!Junk) return;

      await Promise.all([
        (async () => {
          const junk = junkFromContract(
            junkId,
            await Junk.methods.get('' + junkId).call(defaultCallOptions(state))
          );

          commit('updateJunk', { junkId, junk });
        })(),
      ]);
    },

    async fetchKeyLootboxes({ commit }, keyLootboxesIds: (string | number)[]) {
      keyLootboxesIds.forEach(id => {
        const keybox: Nft = { id, type: 'keybox' };
        commit('updateKeyLootbox', { keyLootboxId: id, keybox });
      });
    },

    async setupWeaponDurabilities({ dispatch }) {
      const ownedWeaponIds = await dispatch('getAccountWeapons');

      for (const weapId of ownedWeaponIds) {
        dispatch('fetchWeaponDurability', weapId);
      }
    },

    async fetchWeaponDurability({ state, commit }, weaponId: number) {
      const durabilityString = await state.contracts().Weapons!.methods
        .getDurabilityPoints('' + weaponId)
        .call(defaultCallOptions(state));

      const durability = parseInt(durabilityString, 10);
      if (state.weaponDurabilities[weaponId] !== durability) {
        commit('updateWeaponDurability', { weaponId, durability });
      }
    },

    async setupWeaponRenames({ dispatch }) {
      const ownedWeaponIds = await dispatch('getAccountWeapons');

      for (const weapId of ownedWeaponIds) {
        dispatch('fetchWeaponRename', weapId);
      }
    },

    async setupWeaponsWithIdsRenames({ dispatch }, weaponIds: string[]) {
      for (const weapId of weaponIds) {
        dispatch('fetchWeaponRename', weapId);
      }
    },

    async fetchWeaponRename({ state, commit }, weaponId: number) {
      const renameString = await state.contracts().WeaponRenameTagConsumables!.methods
        .getWeaponRename(weaponId)
        .call(defaultCallOptions(state));
      if(renameString !== '' && state.weaponRenames[weaponId] !== renameString){
        commit('updateWeaponRename', { weaponId, renameString });
      }
    },

    async setupWeaponCosmetics({ dispatch }) {
      const ownedWeaponIds = await dispatch('getAccountWeapons');

      for (const weapId of ownedWeaponIds) {
        dispatch('fetchWeaponCosmetic', weapId);
      }
    },

    async setupWeaponsWithIdsCosmetics({ dispatch }, weaponIds: string[]) {
      for (const weapId of weaponIds) {
        dispatch('fetchWeaponCosmetic', weapId);
      }
    },

    async fetchWeaponCosmetic({ state, commit }, weaponId: number) {
      const weaponCosmetic = await state.contracts().WeaponCosmetics!.methods
        .getWeaponCosmetic(weaponId)
        .call(defaultCallOptions(state));
      if(state.weaponCosmetics[weaponId] !== weaponCosmetic){
        commit('updateWeaponCosmetic', { weaponId, weaponCosmetic });
      }
    },

    async setupCharacterStaminas({ dispatch }) {
      const ownedCharacterIds = await dispatch('getAccountCharacters');
      const ownedGarrisonCharacterIds = await dispatch('getAccountGarrisonCharacters');
      ownedCharacterIds.push(...ownedGarrisonCharacterIds);

      for (const charId of ownedCharacterIds) {
        dispatch('fetchCharacterStamina', charId);
      }
    },

    async fetchCharacterStamina({ state, commit }, characterId: number) {
      const staminaString = await state.contracts().Characters!.methods
        .getStaminaPoints('' + characterId)
        .call(defaultCallOptions(state));

      const stamina = parseInt(staminaString, 10);
      if (state.characterStaminas[characterId] !== stamina) {
        commit('updateCharacterStamina', { characterId, stamina });
      }
    },
    async getAccountCharacters({state}) {
      if(!state.defaultAccount) return;
      const numberOfCharacters = parseInt(await state.contracts().Characters!.methods.balanceOf(state.defaultAccount).call(defaultCallOptions(state)), 10);
      return await Promise.all(
        [...Array(numberOfCharacters).keys()].map(async (_, i) =>
          Number(await state.contracts().Characters!.methods.tokenOfOwnerByIndex(state.defaultAccount!, i).call(defaultCallOptions(state))))
      );
    },
    async getAccountGarrisonCharacters({state}) {
      if(!state.defaultAccount) return;
      return (await state.contracts().Garrison!.methods.getUserCharacters().call(defaultCallOptions(state))).map((id) => Number(id));
    },
    async getAccountWeapons({state}) {
      if(!state.defaultAccount) return;
      const numberOfWeapons = parseInt(await state.contracts().Weapons!.methods.balanceOf(state.defaultAccount).call(defaultCallOptions(state)), 10);
      return await Promise.all(
        [...Array(numberOfWeapons).keys()]
          .map(async (_, i) => Number(await state.contracts().Weapons!.methods.tokenOfOwnerByIndex(state.defaultAccount!, i).call(defaultCallOptions(state))))
      );
    },
    async setupCharacterRenames({ dispatch }) {
      const ownedCharacterIds = await dispatch('getAccountCharacters');
      const ownedGarrisonCharacterIds = await dispatch('getAccountGarrisonCharacters');
      ownedCharacterIds.push(...ownedGarrisonCharacterIds);

      for (const charId of ownedCharacterIds) {
        dispatch('fetchCharacterRename', charId);
      }
    },
    async setupCharactersWithIdsRenames({ dispatch }, characterIds: string[]) {
      for (const charId of characterIds) {
        dispatch('fetchCharacterRename', charId);
      }
    },
    async fetchCharacterRename({ state, commit }, characterId: number) {
      const renameString = await state.contracts().CharacterRenameTagConsumables!.methods
        .getCharacterRename(characterId)
        .call(defaultCallOptions(state));
      if(renameString !== '' && state.characterRenames[characterId] !== renameString){
        commit('updateCharacterRename', { characterId, renameString });
      }
    },
    async setupCharacterCosmetics({ dispatch }) {
      const ownedCharacterIds = await dispatch('getAccountCharacters');
      const ownedGarrisonCharacterIds = await dispatch('getAccountGarrisonCharacters');
      ownedCharacterIds.push(...ownedGarrisonCharacterIds);

      for (const charId of ownedCharacterIds) {
        dispatch('fetchCharacterCosmetic', charId);
      }
    },
    async fetchCharacterCosmetic({ state, commit }, characterId: number) {
      const characterCosmetic = await state.contracts().CharacterCosmetics!.methods
        .getCharacterCosmetic(characterId)
        .call(defaultCallOptions(state));
      if(state.characterCosmetics[characterId] !== characterCosmetic){
        commit('updateCharacterCosmetic', { characterId, characterCosmetic });
      }
    },
    async mintCharacter({ state, dispatch }, approveMintSlippage: boolean) {
      if(!state.defaultAccount) return;
      const slippageMultiplier = approveMintSlippage ? 1.05 : 1;

      await approveFee(
        state.contracts().CryptoBlades!,
        state.contracts().SkillToken,
        state.defaultAccount,
        state.skillRewards,
        defaultCallOptions(state),
        defaultCallOptions(state),
        cryptoBladesMethods => cryptoBladesMethods.getMintCharacterFee(),
        { feeMultiplier: slippageMultiplier, allowInGameOnlyFunds: false }
      );

      await state.contracts().CryptoBlades!.methods.mintCharacter().send(defaultCallOptions(state));

      await Promise.all([
        dispatch('fetchFightRewardSkill'),
        dispatch('fetchFightRewardXp'),
        dispatch('setupCharacterStaminas')
      ]);
    },

    async mintWeaponN({ state, dispatch }, { num, useStakedSkillOnly, chosenElement, eventId = 0, mintSlippageApproved }:
    { num: any, useStakedSkillOnly?: boolean, chosenElement: any, eventId: any, mintSlippageApproved: boolean }) {
      const { CryptoBlades, SkillToken, Weapons } = state.contracts();
      if(!CryptoBlades || !SkillToken || !Weapons || !state.defaultAccount) return;
      const chosenElementFee = chosenElement === 100 ? 1 : 2;
      const slippageMultiplier = mintSlippageApproved ? 1.05 : 1;

      if(useStakedSkillOnly) {
        await CryptoBlades.methods
          .mintWeaponNUsingStakedSkill(num, chosenElement, eventId)
          .send({ from: state.defaultAccount, gas: '5000000', gasPrice: getGasPrice(), });
      }
      else {
        await approveFee(
          CryptoBlades,
          SkillToken,
          state.defaultAccount,
          state.skillRewards,
          defaultCallOptions(state),
          defaultCallOptions(state),
          cryptoBladesMethods => cryptoBladesMethods.getMintWeaponFee(),
          { feeMultiplier: num * 4 * chosenElementFee * slippageMultiplier, allowInGameOnlyFunds: true }
        );

        if (!await CryptoBlades.methods.hasSeed(num).call(defaultCallOptions(state))) {
          await CryptoBlades.methods.generateSeed(num).send(defaultCallOptions(state));
        }

        await CryptoBlades.methods.mintWeaponN(num, chosenElement, eventId).send({ from: state.defaultAccount, gas: '5000000', gasPrice: getGasPrice(), });
      }

      await Promise.all([
        dispatch('fetchSkillBalance'),
        dispatch('fetchFightRewardSkill'),
        dispatch('updateWeaponIds'),
        dispatch('setupWeaponDurabilities'),
        dispatch('specialWeaponsManager/fetchShardsSupply')
      ]);
    },

    async mintWeapon({ state, dispatch }, { useStakedSkillOnly, chosenElement, eventId = 0, mintSlippageApproved }:
    { useStakedSkillOnly?: boolean, chosenElement: any, eventId: any, mintSlippageApproved: boolean }) {
      const { CryptoBlades, SkillToken, Weapons } = state.contracts();
      if(!CryptoBlades || !SkillToken || !Weapons || !state.defaultAccount) return;
      const chosenElementFee = chosenElement === 100 ? 1 : 2;
      const slippageMultiplier = mintSlippageApproved ? 1.05 : 1;

      if(useStakedSkillOnly) {
        await CryptoBlades.methods
          .mintWeaponUsingStakedSkill(chosenElement, eventId)
          .send({ from: state.defaultAccount, gasPrice: getGasPrice(), });
      }
      else {
        await approveFee(
          CryptoBlades,
          SkillToken,
          state.defaultAccount,
          state.skillRewards,
          defaultCallOptions(state),
          defaultCallOptions(state),
          cryptoBladesMethods => cryptoBladesMethods.getMintWeaponFee(),
          { feeMultiplier: chosenElementFee * slippageMultiplier, allowInGameOnlyFunds: true }
        );

        const quantity = 1;
        if (!await CryptoBlades.methods.hasSeed(quantity).call(defaultCallOptions(state))) {
          await CryptoBlades.methods.generateSeed(quantity).send(defaultCallOptions(state));
        }

        await CryptoBlades.methods.mintWeapon(chosenElement, eventId).send({ from: state.defaultAccount, gasPrice: getGasPrice(), });
      }

      await Promise.all([
        dispatch('fetchSkillBalance'),
        dispatch('fetchFightRewardSkill'),
        dispatch('updateWeaponIds'),
        dispatch('setupWeaponDurabilities'),
        dispatch('specialWeaponsManager/fetchShardsSupply')
      ]);
    },

    async reforgeWeapon(
      { state, dispatch },
      { burnWeaponId, reforgeWeaponId, useStakedSkillOnly }: {
        burnWeaponId: any, reforgeWeaponId: any, useStakedSkillOnly?: boolean
      }
    ) {
      const { CryptoBlades, SkillToken, BurningManager } = state.contracts();
      if(!CryptoBlades || !BurningManager || !state.defaultAccount) return;

      if(useStakedSkillOnly) {
        await BurningManager.methods
          .reforgeWeaponUsingStakedSkill(
            reforgeWeaponId,
            burnWeaponId
          )
          .send({
            from: state.defaultAccount,
            gasPrice: getGasPrice(),
          });
      }
      else {
        await approveFeeDynamic(
          CryptoBlades,
          BurningManager,
          SkillToken,
          state.defaultAccount,
          state.skillRewards,
          defaultCallOptions(state),
          defaultCallOptions(state),
          burningManagerMethods => burningManagerMethods.reforgeWeaponFee(),
          { allowInGameOnlyFunds: false },
        );

        await BurningManager.methods
          .reforgeWeapon(
            reforgeWeaponId,
            burnWeaponId
          )
          .send({
            from: state.defaultAccount,
            gasPrice: getGasPrice(),
          });
      }

      await Promise.all([
        dispatch('fetchSkillBalance'),
        dispatch('updateWeaponIds'),
        dispatch('fetchFightRewardSkill'),
        dispatch('fetchFightRewardXp')
      ]);
    },

    async reforgeWeaponWithDust(
      { state, dispatch },
      { reforgeWeaponId, lesserDust, greaterDust, powerfulDust, useStakedSkillOnly }: {
        reforgeWeaponId: any, lesserDust: any, greaterDust: any, powerfulDust: any,
        useStakedSkillOnly?: boolean
      }
    ) {
      const { CryptoBlades, SkillToken, BurningManager } = state.contracts();
      if(!CryptoBlades || !BurningManager || !state.defaultAccount) return;

      if(useStakedSkillOnly) {
        await BurningManager.methods
          .reforgeWeaponWithDustUsingStakedSkill(
            reforgeWeaponId,
            lesserDust,
            greaterDust,
            powerfulDust
          )
          .send({
            from: state.defaultAccount,
            gasPrice: getGasPrice(),
          });
      }
      else {
        await approveFeeDynamic(
          CryptoBlades,
          BurningManager,
          SkillToken,
          state.defaultAccount,
          state.skillRewards,
          defaultCallOptions(state),
          defaultCallOptions(state),
          burningManagerMethods => burningManagerMethods.reforgeWeaponWithDustFee(),
          { allowInGameOnlyFunds: false },
        );

        await BurningManager.methods
          .reforgeWeaponWithDust(
            reforgeWeaponId,
            lesserDust,
            greaterDust,
            powerfulDust
          )
          .send({
            from: state.defaultAccount,
            gasPrice: getGasPrice(),
          });
      }

      await Promise.all([
        dispatch('fetchSkillBalance'),
        dispatch('updateWeaponIds'),
        dispatch('fetchFightRewardSkill'),
        dispatch('fetchFightRewardXp'),
        dispatch('fetchDustBalance')
      ]);
    },

    async massBurnWeapons({ state, dispatch }, { burnWeaponIds, useStakedSkillOnly }: { burnWeaponIds: any[], useStakedSkillOnly?: boolean }) {
      const { CryptoBlades, SkillToken, BurningManager } = state.contracts();
      if(!CryptoBlades || !BurningManager || !state.defaultAccount) return;

      if(useStakedSkillOnly) {
        await BurningManager.methods
          .burnWeaponsUsingStakedSkill(
            burnWeaponIds
          )
          .send({
            from: state.defaultAccount,
            gasPrice: getGasPrice(),
          });
      }
      else {
        await approveFeeDynamic(
          CryptoBlades,
          BurningManager,
          SkillToken,
          state.defaultAccount,
          state.skillRewards,
          defaultCallOptions(state),
          defaultCallOptions(state),
          burningManagerMethods => burningManagerMethods.burnWeaponFee(),
          { feeMultiplier: burnWeaponIds.length }
        );

        await BurningManager.methods
          .burnWeapons(
            burnWeaponIds
          )
          .send({
            from: state.defaultAccount,
            gasPrice: getGasPrice(),
          });
      }

      await Promise.all([
        dispatch('fetchSkillBalance'),
        dispatch('updateWeaponIds'),
        dispatch('fetchFightRewardSkill'),
        dispatch('fetchFightRewardXp'),
        dispatch('fetchDustBalance')
      ]);
    },

    async fetchReforgeWeaponFee({ state }) {
      const { BurningManager } = state.contracts();
      if(!state.defaultAccount || !BurningManager) return;
      return await BurningManager.methods.reforgeWeaponFee().call({ from: state.defaultAccount });
    },

    async fetchReforgeWeaponWithDustFee({ state }) {
      const { BurningManager } = state.contracts();
      if(!state.defaultAccount || !BurningManager) return;
      return await BurningManager.methods.reforgeWeaponWithDustFee().call({ from: state.defaultAccount });
    },

    async fetchBurnWeaponFee({ state }) {
      const { BurningManager } = state.contracts();
      if(!state.defaultAccount || !BurningManager) return;
      return await BurningManager.methods.burnWeaponFee().call({ from: state.defaultAccount });
    },

    async fetchTargets({ state, commit }, { characterId, weaponId }) {
      if(isUndefined(characterId) || isUndefined(weaponId)) {
        commit('updateTargets', { characterId, weaponId, targets: [] });
        return;
      }

      const targets = await state.contracts().CryptoBlades!.methods
        .getTargets(characterId, weaponId)
        .call(defaultCallOptions(state));

      commit('updateTargets', { characterId, weaponId, targets: targets.map(targetFromContract) });
    },

    async fetchExpectedPayoutForMonsterPower({ state }, { power, isCalculator = false }) {
      const { CryptoBlades } = state.contracts();
      if(!CryptoBlades) return;
      if(isCalculator) {
        return await CryptoBlades.methods.getTokenGainForFight(power, false).call(defaultCallOptions(state));
      }
      return await CryptoBlades.methods.getTokenGainForFight(power, true).call(defaultCallOptions(state));
    },

    async fetchHourlyPowerAverage({ state }) {
      const { CryptoBlades } = state.contracts();
      if(!CryptoBlades) return;
      return await CryptoBlades.methods.vars(4).call(defaultCallOptions(state));
    },
    async fetchHourlyPayPerFight({ state }) {
      const { CryptoBlades } = state.contracts();
      if(!CryptoBlades) return;
      return await CryptoBlades.methods.vars(5).call(defaultCallOptions(state));
    },
    async fetchHourlyAllowance({ state }) {
      const { CryptoBlades } = state.contracts();
      if(!CryptoBlades) return;
      return await CryptoBlades.methods.vars(18).call(defaultCallOptions(state));
    },

    async fetchRemainingTokenClaimAmountPreTax({ state }) {
      if(!_.isFunction(state.contracts)) return;
      const { CryptoBlades } = state.contracts();
      if(!CryptoBlades) return;
      return await CryptoBlades.methods.getRemainingTokenClaimAmountPreTax().call(defaultCallOptions(state));
    },

    async fetchIsLandSaleAllowed({state}) {
      const CBKLandSale = state.contracts().CBKLandSale!;

      return await CBKLandSale.methods
        .salesAllowed()
        .call(defaultCallOptions(state));
    },

    async getAllZonesPopulation({state}) {
      const CBKLandSale = state.contracts().CBKLandSale!;

      return await CBKLandSale.methods
        .getAllZonesPopulation()
        .call(defaultCallOptions(state));
    },

    async checkIfChunkAvailable({state}, {tier, chunkId}) {
      const CBKLandSale = state.contracts().CBKLandSale!;

      return await CBKLandSale.methods
        .checkIfChunkAvailable(tier, chunkId)
        .call(defaultCallOptions(state));
    },

    async getZoneChunkPopulation({state}, {zoneId}) {
      const CBKLandSale = state.contracts().CBKLandSale!;

      return await CBKLandSale.methods
        .getZoneChunkPopulation(zoneId)
        .call(defaultCallOptions(state));
    },

    async getAvailableLand({state}) {
      const CBKLandSale = state.contracts().CBKLandSale!;

      const res = await CBKLandSale.methods
        .getAvailableLand()
        .call(defaultCallOptions(state));

      const t1Land = res[0];
      const t2Land = res[1];
      const t3Land = res[2];

      return { t1Land, t2Land, t3Land };
    },

    async getOwnedLands({state}) {
      const CBKLand = state.contracts().CBKLand!;

      if (!state.defaultAccount || !CBKLand) return;

      const landsIds = await CBKLand.methods
        .getOwned(state.defaultAccount)
        .call(defaultCallOptions(state));

      return await Promise.all(landsIds.map(landId => CBKLand.methods.get(landId).call(defaultCallOptions(state))));
    },

    async getOwnedLandIdsWithTier({state}) {
      const CBKLand = state.contracts().CBKLand!;

      if (!state.defaultAccount || !CBKLand) return;

      const landsIds = await CBKLand.methods
        .getOwned(state.defaultAccount)
        .call(defaultCallOptions(state));

      return await Promise.all(landsIds.map(async (landId: string) => {
        const land = await CBKLand.methods.get(landId).call(defaultCallOptions(state));
        return {id: landId, tier: land[0]};
      }));
    },

    async mintCBKLand({state}, {minter, tier, chunkId, reseller}) {
      const {CBKLand} = state.contracts();

      if (!CBKLand || !state.defaultAccount) return;

      return await CBKLand.methods.mint(minter, tier, chunkId, reseller).send({from: state.defaultAccount, gasPrice: getGasPrice()});
    },

    async massMintCBKLand({state}, {minter, tier, chunkId, reseller, quantity}) {
      const {CBKLand} = state.contracts();

      if (!CBKLand || !state.defaultAccount) return;

      return await CBKLand.methods.massMint(minter, tier, chunkId, reseller, quantity).send({from: state.defaultAccount, gasPrice: getGasPrice()});
    },

    async updateChunkId({state}, {id, chunkId}) {
      const {CBKLand} = state.contracts();

      if (!CBKLand || !state.defaultAccount) return;

      return await CBKLand.methods.updateChunkId(id, chunkId).send({from: state.defaultAccount, gasPrice: getGasPrice()});
    },

    async updateChunkIds({state}, {ids, chunkId}) {
      const {CBKLand} = state.contracts();

      if (!CBKLand || !state.defaultAccount) return;

      return await CBKLand.methods.updateChunkId(ids, chunkId).send({from: state.defaultAccount, gasPrice: getGasPrice()});
    },

    async incrementDustSupplies({state}, {playerAddress, amountLB, amount4B, amount5B}) {
      const {Weapons} = state.contracts();
      if(!state.defaultAccount || !Weapons) return;

      return await Weapons.methods.incrementDustSupplies(playerAddress, amountLB, amount4B, amount5B).send({
        from: state.defaultAccount,
        gasPrice: getGasPrice()
      });
    },

    async decrementDustSupplies({state}, {playerAddress, amountLB, amount4B, amount5B}) {
      const {Weapons} = state.contracts();
      if(!state.defaultAccount || !Weapons) return;

      return await Weapons.methods.decrementDustSupplies(playerAddress, amountLB, amount4B, amount5B).send({
        from: state.defaultAccount,
        gasPrice: getGasPrice()
      });
    },

    async mintGiveawayWeapon({state}, {to, stars, chosenElement}) {
      const {Weapons} = state.contracts();
      if(!state.defaultAccount || !Weapons) return;

      return await Weapons.methods.mintGiveawayWeapon(to, stars, chosenElement).send({from: state.defaultAccount, gasPrice: getGasPrice()});
    },

    async giveAwaySoul({state}, {user, soulAmount}) {
      const {BurningManager} = state.contracts();
      if(!state.defaultAccount || !BurningManager) return;

      return await BurningManager.methods.giveAwaySoul(user, soulAmount).send({from: state.defaultAccount, gasPrice: getGasPrice()});
    },

    async getSoulMultiplier({state}) {
      const {BurningManager} = state.contracts();
      if(!state.defaultAccount || !BurningManager) return;

      const VAR_BURN_POWER_MULTIPLIER = await BurningManager.methods.VAR_BURN_POWER_MULTIPLIER().call(defaultCallOptions(state));

      return await BurningManager.methods.vars(VAR_BURN_POWER_MULTIPLIER).call(defaultCallOptions(state));
    },

    async setSoulMultiplier({state}, {multiplier}) {
      const {BurningManager} = state.contracts();
      if(!state.defaultAccount || !BurningManager) return;

      const VAR_BURN_POWER_MULTIPLIER = await BurningManager.methods.VAR_BURN_POWER_MULTIPLIER().call(defaultCallOptions(state));

      return await BurningManager.methods.setVar(VAR_BURN_POWER_MULTIPLIER, Web3.utils.toWei('' + multiplier))
        .send({from: state.defaultAccount, gasPrice: getGasPrice()});
    },

    async fetchMarketNftPrice({ state }, { nftContractAddr, tokenId }) {
      const { NFTMarket } = state.contracts();
      if(!NFTMarket) return;

      // returns the listing's price in skill wei
      return await NFTMarket.methods
        .getFinalPrice(
          nftContractAddr,
          tokenId
        )
        .call(defaultCallOptions(state));
    },

    async checkMarketItemOwnership({ state }, { nftContractAddr, tokenId }) {
      const { NFTMarket, Weapons, Characters } = state.contracts();
      if(!NFTMarket || !Weapons || !Characters) return;

      const NFTContract: Contract<IERC721> =
        nftContractAddr === Weapons.options.address
          ? Weapons
          : Characters;

      return await NFTContract.methods
        .ownerOf(tokenId)
        .call(defaultCallOptions(state));
    },

    async fetchFightGasOffset({ state, commit }) {
      const { CryptoBlades } = state.contracts();
      if(!CryptoBlades) return;
      const fightGasOffset = await getFeeInSkillFromUsd(
        CryptoBlades,
        defaultCallOptions(state),
        cryptoBladesMethods => cryptoBladesMethods.fightRewardGasOffset()
      );

      commit('updateFightGasOffset', { fightGasOffset });
      return fightGasOffset;
    },

    async fetchFightBaseline({ state, commit }) {
      const { CryptoBlades } = state.contracts();
      if(!CryptoBlades) return;

      const fightBaseline = await getFeeInSkillFromUsd(
        CryptoBlades,
        defaultCallOptions(state),
        cryptoBladesMethods => cryptoBladesMethods.fightRewardBaseline()
      );

      commit('updateFightBaseline', { fightBaseline });
      return fightBaseline;
    },

    async fetchFightRewardSkill({ state, commit }) {
      const { CryptoBlades } = state.contracts();
      if(!CryptoBlades) return;

      const [skillRewards] = await Promise.all([
        (async () => {
          const skillRewards = await CryptoBlades.methods
            .getTokenRewards()
            .call(defaultCallOptions(state));

          commit('updateSkillRewards', { skillRewards });

          return skillRewards;
        })()
      ]);

      return skillRewards;
    },

    async fetchFightRewardXp({ state, commit }) {
      const { CryptoBlades } = state.contracts();
      if(!CryptoBlades) return;

      const xps = await CryptoBlades.methods.getXpRewards(state.ownedCharacterIds.map(x => x.toString())).call(defaultCallOptions(state));

      const xpCharaIdPairs = state.ownedCharacterIds.map((charaId, i) => {
        return [charaId, xps[i]];
      });

      commit('updateXpRewards', { xpRewards: _.fromPairs(xpCharaIdPairs) });
      return xpCharaIdPairs;
    },

    async fetchGarrisonCharactersXp({ state, commit }) {
      const { CryptoBlades } = state.contracts();
      if(!CryptoBlades) return;

      const xps = await CryptoBlades.methods.getXpRewards(state.ownedGarrisonCharacterIds.map(x => x.toString())).call(defaultCallOptions(state));

      const xpCharaIdPairs = state.ownedGarrisonCharacterIds.map((charaId, i) => {
        return [charaId, xps[i]];
      });

      commit('updateXpRewards', { xpRewards: _.fromPairs(xpCharaIdPairs) });
    },

    async claimGarrisonXp({ state, dispatch }, characterIds) {
      const { Garrison } = state.contracts();
      if(!Garrison) return;
      await Garrison.methods.claimAllXp(characterIds).send({ from: state.defaultAccount, gasPrice: getGasPrice() });

      await Promise.all([
        dispatch('fetchGarrisonCharacters', state.ownedGarrisonCharacterIds),
        dispatch('fetchGarrisonCharactersXp')
      ]);
    },

    async storeNftsToPartnerVault({state}, {tokenAddress, tokenIds}) {
      const {PartnerVault} = state.contracts();
      if(!PartnerVault || !state.defaultAccount) return;

      const tokenContract = new state.web3.eth.Contract(erc721Abi as any[], tokenAddress) as Contract<IERC721>;

      const isApprovedForAll = await tokenContract.methods.isApprovedForAll(state.defaultAccount, PartnerVault.options.address)
        .call(defaultCallOptions(state));

      if(tokenIds.length === 1 && !isApprovedForAll) {
        await tokenContract.methods.approve(PartnerVault.options.address, tokenIds[0]).send({
          from: state.defaultAccount,
          gasPrice: getGasPrice()
        });
      } else if (!isApprovedForAll) {
        await tokenContract.methods.setApprovalForAll(PartnerVault.options.address, true).send({
          from: state.defaultAccount,
          gasPrice: getGasPrice()
        });
      }
      return await PartnerVault.methods.storeNfts(tokenAddress, tokenIds).send({
        from: state.defaultAccount,
        gasPrice: getGasPrice()
      });
    },

    async storeCurrencyToPartnerVault({state}, {currencyAddress, amount}) {
      const {PartnerVault} = state.contracts();
      if (!PartnerVault || !state.defaultAccount) return;

      const currencyContract = new state.web3.eth.Contract(erc20Abi as any[], currencyAddress) as Contract<ERC20>;
      const currencyDecimals = +await currencyContract.methods.decimals().call(defaultCallOptions(state));
      const amountTimesDecimals = new BigNumber(amount).multipliedBy(new BigNumber(10 ** currencyDecimals));

      await currencyContract.methods.approve(PartnerVault.options.address, amountTimesDecimals.toString()).send({
        from: state.defaultAccount,
        gasPrice: getGasPrice()
      });

      return await PartnerVault.methods.storeCurrency(currencyAddress, amountTimesDecimals.toString()).send({
        from: state.defaultAccount,
        gasPrice: getGasPrice()
      });
    },

    async getNftsInPartnerVault({state}, {tokenAddress}){
      const {PartnerVault} = state.contracts();
      if(!PartnerVault || !state.defaultAccount) return;

      return await PartnerVault.methods.getNftsInVault(tokenAddress).call(defaultCallOptions(state));
    },

    async getCurrencyBalanceInPartnerVault({state}, {currencyAddress}){
      const {PartnerVault} = state.contracts();
      if(!PartnerVault || !state.defaultAccount || !state.web3) return;

      const currencyContract = new state.web3.eth.Contract(erc20Abi as any[], currencyAddress) as Contract<ERC20>;
      let currencyBalance = await currencyContract.methods.balanceOf(PartnerVault.options.address).call(defaultCallOptions(state));
      const currencyDecimals = +await currencyContract.methods.decimals().call(defaultCallOptions(state));
      currencyBalance = new BigNumber(currencyBalance).div(new BigNumber(10 ** currencyDecimals)).toFixed();
      const currencySymbol = await currencyContract.methods.symbol().call(defaultCallOptions(state));

      return [currencyBalance, currencySymbol];
    },

    async getCharacterBusyStatus({state}, {characterId}) {
      const { Characters } = state.contracts();
      if(!Characters || !state.defaultAccount) return;

      const NFTVAR_BUSY = await Characters.methods.NFTVAR_BUSY().call(defaultCallOptions(state));

      return await Characters.methods.getNftVar(characterId, NFTVAR_BUSY).call(defaultCallOptions(state));
    },

    async isExternalCurrency({state}, {currencyAddress}) {
      try{
        const currencyContract = new state.web3.eth.Contract(erc20Abi as any[], currencyAddress) as Contract<ERC20>;
        await currencyContract.methods.decimals().call(defaultCallOptions(state));
        return true;
      } catch (e) {
        return false;
      }
    },

    async grantRole({state}, {walletAddress, contract, roleMethod}) {
      if (!contract || !state.defaultAccount || !Web3.utils.isAddress(walletAddress)) return;

      const role = await roleMethod().call(defaultCallOptions(state));

      await contract.methods.grantRole(role, walletAddress).send(defaultCallOptions(state));
    },

    async revokeRole({state}, {walletAddress, contract, roleMethod}) {
      if (!contract || !state.defaultAccount || !Web3.utils.isAddress(walletAddress)) return;

      const role = await roleMethod().call(defaultCallOptions(state));

      await contract.methods.revokeRole(role, walletAddress).send(defaultCallOptions(state));
    },

    async userHasDefaultAdminAccess({state}, {contract}) {
      if (!contract || !contract.methods.DEFAULT_ADMIN_ROLE || !state.defaultAccount) return;

      const defaultAdminRole = await contract.methods.DEFAULT_ADMIN_ROLE().call(defaultCallOptions(state));

      return await contract.methods.hasRole(defaultAdminRole, state.defaultAccount).call(defaultCallOptions(state));
    },

    async userHasGameAdminAccess({state}, {contract}) {
      if (!contract || !contract.methods.GAME_ADMIN || !state.defaultAccount) return;

      const gameAdminRole = await contract.methods.GAME_ADMIN().call(defaultCallOptions(state));

      return await contract.methods.hasRole(gameAdminRole, state.defaultAccount).call(defaultCallOptions(state));
    },

    async userHasMinterAccess({state}, {contract}) {
      if (!contract || !contract.methods.MINTER_ROLE || !state.defaultAccount) return;

      const minterRole = await contract.methods.MINTER_ROLE().call(defaultCallOptions(state));

      return await contract.methods.hasRole(minterRole, state.defaultAccount).call(defaultCallOptions(state));
    },

    async fetchHasAdminAccess({state, commit}) {
      const {SimpleQuests,
        CBKLand,
        Weapons,
        BurningManager,
        PartnerVault,
        Treasury,
        CryptoBlades,
        Blacksmith,
      } = state.contracts();
      if (!SimpleQuests
        || !CBKLand
        || !Weapons
        || !BurningManager
        || !PartnerVault
        || !Treasury
        || !CryptoBlades
        || !Blacksmith
        || !state.defaultAccount) return;

      const simpleQuestsAdminRole = await SimpleQuests.methods.GAME_ADMIN().call(defaultCallOptions(state));
      const cbkLandAdminRole = await CBKLand.methods.GAME_ADMIN().call(defaultCallOptions(state));
      const weaponsAdminRole = await Weapons.methods.GAME_ADMIN().call(defaultCallOptions(state));
      const burningManagerAdminRole = await BurningManager.methods.GAME_ADMIN().call(defaultCallOptions(state));
      const partnerVaultAdminRole = await PartnerVault.methods.GAME_ADMIN().call(defaultCallOptions(state));
      const treasuryAdminRole = await Treasury.methods.GAME_ADMIN().call(defaultCallOptions(state));
      const cryptoBladesAdminRole = await CryptoBlades.methods.GAME_ADMIN().call(defaultCallOptions(state));
      const blacksmithAdminRole = await Blacksmith.methods.DEFAULT_ADMIN_ROLE().call(defaultCallOptions(state));

      const promises: Promise<boolean>[] = [
        SimpleQuests.methods.hasRole(simpleQuestsAdminRole, state.defaultAccount).call(defaultCallOptions(state)),
        CBKLand.methods.hasRole(cbkLandAdminRole, state.defaultAccount).call(defaultCallOptions(state)),
        Weapons.methods.hasRole(weaponsAdminRole, state.defaultAccount).call(defaultCallOptions(state)),
        BurningManager.methods.hasRole(burningManagerAdminRole, state.defaultAccount).call(defaultCallOptions(state)),
        PartnerVault.methods.hasRole(partnerVaultAdminRole, state.defaultAccount).call(defaultCallOptions(state)),
        Treasury.methods.hasRole(treasuryAdminRole, state.defaultAccount).call(defaultCallOptions(state)),
        CryptoBlades.methods.hasRole(cryptoBladesAdminRole, state.defaultAccount).call(defaultCallOptions(state)),
        Blacksmith.methods.hasRole(blacksmithAdminRole, state.defaultAccount).call(defaultCallOptions(state)),
      ];

      for (const promise of promises) {
        if (await promise) return commit('updateHasAdminAccess', true);
      }
      return commit('updateHasAdminAccess', false);
    },

    async fetchHasMinterAccess({state, commit}) {
      const {Weapons, Characters} = state.contracts();
      if (!Weapons || !Characters || !state.defaultAccount) return;

      const weaponsMinerRole = await Weapons.methods.MINTER_ROLE().call(defaultCallOptions(state));
      const charactersMinerRole = await Characters.methods.MINTER_ROLE().call(defaultCallOptions(state));

      const promises: Promise<boolean>[] = [
        Weapons.methods.hasRole(weaponsMinerRole, state.defaultAccount).call(defaultCallOptions(state)),
        Characters.methods.hasRole(charactersMinerRole, state.defaultAccount).call(defaultCallOptions(state)),
      ];

      for (const promise of promises) {
        if (await promise) return commit('updateHasMinterAccess', true);
      }
      return commit('updateHasMinterAccess', false);
    },

    async canUserAfford({ state }, {payingAmount}) {
      const { CryptoBlades } = state.contracts();
      if(!CryptoBlades || !state.defaultAccount) return;

      const unclaimedSkill = await CryptoBlades.methods
        .getTokenRewardsFor(state.defaultAccount)
        .call(defaultCallOptions(state));

      const walletSkill = state.skillBalance;

      const totalSkill = +unclaimedSkill + +walletSkill;

      return totalSkill >= payingAmount;
    },

    async claimTokenRewards({ state, dispatch }) {
      const { CryptoBlades } = state.contracts();
      if(!CryptoBlades) return;

      await CryptoBlades.methods.claimTokenRewards().send({
        from: state.defaultAccount,
        gasPrice: getGasPrice()
      });

      await Promise.all([
        dispatch('fetchSkillBalance'),
        dispatch('fetchFightRewardSkill')
      ]);
    },

    async claimXpRewards({ state, dispatch }) {
      const { CryptoBlades } = state.contracts();
      if(!CryptoBlades) return;

      await CryptoBlades.methods.claimXpRewards().send({
        from: state.defaultAccount,
        gasPrice: getGasPrice(),
      });

      await Promise.all([
        dispatch('fetchCharacters', state.ownedCharacterIds),
        dispatch('fetchFightRewardXp')
      ]);
    },

    async setCharacterMintValue({state}, {cents}) {
      const {CryptoBlades} = state.contracts();
      if (!CryptoBlades) return;

      await CryptoBlades.methods.setCharacterMintValue(cents).send({
        from: state.defaultAccount,
        gasPrice: getGasPrice(),
      });
    },

    async setWeaponMintValue({state}, {cents}) {
      const {CryptoBlades} = state.contracts();
      if (!CryptoBlades) return;

      await CryptoBlades.methods.setWeaponMintValue(cents).send({
        from: state.defaultAccount,
        gasPrice: getGasPrice(),
      });
    },

    async getCharacterMintValue({state}) {
      const {CryptoBlades} = state.contracts();
      if (!CryptoBlades) return;

      const fee = +await CryptoBlades.methods.mintCharacterFee().call(defaultCallOptions(state));
      return Number(BigInt(fee) >> BigInt(64)) * 100;
    },

    async getWeaponMintValue({state}) {
      const {CryptoBlades} = state.contracts();
      if (!CryptoBlades) return;

      const fee = +await CryptoBlades.methods.mintWeaponFee().call(defaultCallOptions(state));
      return Number(BigInt(fee) >> BigInt(64)) * 100;
    },

    async getFightXpGain({state}) {
      const {CryptoBlades} = state.contracts();
      if (!CryptoBlades) return;

      return +await CryptoBlades.methods.fightXpGain().call(defaultCallOptions(state));
    },

    async setFightXpGain({state}, {xpGain}) {
      const {CryptoBlades} = state.contracts();
      if (!CryptoBlades) return;

      await CryptoBlades.methods.setFightXpGain(xpGain).send({
        from: state.defaultAccount,
        gasPrice: getGasPrice(),
      });
    },

    async setHourlyIncome({state}, {hourlyIncome}) {
      const {CryptoBlades} = state.contracts();
      if(!state.defaultAccount || !CryptoBlades) return;

      const VAR_HOURLY_INCOME = await CryptoBlades.methods.VAR_HOURLY_INCOME().call(defaultCallOptions(state));

      return await CryptoBlades.methods.setVar(VAR_HOURLY_INCOME, Web3.utils.toWei(hourlyIncome.toString(), 'ether').toString())
        .send({from: state.defaultAccount, gasPrice: getGasPrice()});
    },

    async getRaidXpReward({state}) {
      const {Raid1} = state.contracts();
      if (!Raid1) return;

      return +await Raid1.methods.xpReward().call(defaultCallOptions(state));
    },

    async setRaidXpReward({state}, {xp}) {
      const {Raid1} = state.contracts();
      if (!Raid1) return;

      await Raid1.methods.setXpReward(xp).send({
        from: state.defaultAccount,
        gasPrice: getGasPrice(),
      });
    },

    async setFlatPriceOfItem({state}, {itemIndex, price}) {
      const {Blacksmith} = state.contracts();
      if (!Blacksmith) return;

      price = Web3.utils.toWei(price.toString(), 'ether').toString();

      await Blacksmith.methods.setFlatPriceOfItem(itemIndex, price).send({
        from: state.defaultAccount,
        gasPrice: getGasPrice(),
      });
    },

    async setFlatPriceOfItemSeries({state}, {itemIndex, indices, prices}) {
      const {Blacksmith} = state.contracts();
      if (!Blacksmith) return;

      prices = prices.map((price: number) => Web3.utils.toWei(price.toString(), 'ether').toString());

      await Blacksmith.methods.setFlatPriceOfItemSeries(itemIndex, indices, prices).send({
        from: state.defaultAccount,
        gasPrice: getGasPrice(),
      });
    },

    async fetchWaxBridgeDetails({ state, commit }) {
      const { WaxBridge } = state.contracts();
      if(!WaxBridge || !state.defaultAccount) return;

      const [
        waxBridgeWithdrawableBnb,
        waxBridgeRemainingWithdrawableBnbDuringPeriod,
        waxBridgeTimeUntilLimitExpires
      ] = await Promise.all([
        WaxBridge.methods.withdrawableBnb(state.defaultAccount).call(defaultCallOptions(state)),
        WaxBridge.methods.getRemainingWithdrawableBnbDuringPeriod().call(defaultCallOptions(state)),
        WaxBridge.methods.getTimeUntilLimitExpires().call(defaultCallOptions(state)),
      ]);

      const payload: WaxBridgeDetailsPayload = {
        waxBridgeWithdrawableBnb,
        waxBridgeRemainingWithdrawableBnbDuringPeriod,
        waxBridgeTimeUntilLimitExpires: +waxBridgeTimeUntilLimitExpires
      };
      commit('updateWaxBridgeDetails', payload);
    },

    async withdrawBnbFromWaxBridge({ state, dispatch }) {
      const { WaxBridge } = state.contracts();
      if(!WaxBridge || !state.defaultAccount) return;

      await WaxBridge.methods.withdraw(state.waxBridgeWithdrawableBnb).send(defaultCallOptions(state));

      await dispatch('fetchWaxBridgeDetails');
    },

    async fetchTotalRenameTags({ state }) {
      const { CharacterRenameTagConsumables } = state.contracts();
      if(!CharacterRenameTagConsumables || !state.defaultAccount) return;
      return await CharacterRenameTagConsumables.methods.getItemCount().call(defaultCallOptions(state));
    },
    async renameCharacter({ state, dispatch}, {id, name}) {
      const { CryptoBlades, SkillToken, CharacterRenameTagConsumables } = state.contracts();
      if(!CryptoBlades || !SkillToken || !CharacterRenameTagConsumables || !state.defaultAccount) return;

      await CharacterRenameTagConsumables.methods
        .renameCharacter(id, name)
        .send({
          from: state.defaultAccount,
          gas: '5000000',
          gasPrice: getGasPrice(),
        });

      await Promise.all([
        dispatch('fetchCharacterRename', id)
      ]);
    },
    async fetchTotalWeaponRenameTags({ state }) {
      const { WeaponRenameTagConsumables } = state.contracts();
      if(!WeaponRenameTagConsumables || !state.defaultAccount) return;
      return await WeaponRenameTagConsumables.methods.getItemCount().call(defaultCallOptions(state));
    },
    async renameWeapon({ state, dispatch}, {id, name}) {
      const { CryptoBlades, SkillToken, WeaponRenameTagConsumables } = state.contracts();
      if(!CryptoBlades || !SkillToken || !WeaponRenameTagConsumables || !state.defaultAccount) return;

      await WeaponRenameTagConsumables.methods
        .renameWeapon(id, name)
        .send({
          from: state.defaultAccount,
          gas: '5000000',
          gasPrice: getGasPrice()
        });

      await Promise.all([
        dispatch('fetchWeaponRename', id)
      ]);
    },

    async fetchTotalCharacterFireTraitChanges({ state }) {
      const { CharacterFireTraitChangeConsumables } = state.contracts();
      if(!CharacterFireTraitChangeConsumables || !state.defaultAccount) return;
      return await CharacterFireTraitChangeConsumables.methods.getItemCount().call(defaultCallOptions(state));
    },
    async changeCharacterTraitFire({ state, dispatch}, { id }) {
      const { CryptoBlades, SkillToken, CharacterFireTraitChangeConsumables } = state.contracts();
      if(!CryptoBlades || !SkillToken || !CharacterFireTraitChangeConsumables || !state.defaultAccount) return;

      await CharacterFireTraitChangeConsumables.methods
        .changeCharacterTrait(id)
        .send({
          from: state.defaultAccount,
          gas: '5000000',
          gasPrice: getGasPrice()
        });

      await Promise.all([
        dispatch('fetchCharacter', { characterId: id }),
      ]);
    },

    async fetchTotalCharacterEarthTraitChanges({ state }) {
      const { CharacterEarthTraitChangeConsumables } = state.contracts();
      if(!CharacterEarthTraitChangeConsumables || !state.defaultAccount) return;
      return await CharacterEarthTraitChangeConsumables.methods.getItemCount().call(defaultCallOptions(state));
    },
    async changeCharacterTraitEarth({ state, dispatch}, { id }) {
      const { CryptoBlades, SkillToken, CharacterEarthTraitChangeConsumables } = state.contracts();
      if(!CryptoBlades || !SkillToken || !CharacterEarthTraitChangeConsumables || !state.defaultAccount) return;

      await CharacterEarthTraitChangeConsumables.methods
        .changeCharacterTrait(id)
        .send({
          from: state.defaultAccount,
          gas: '5000000',
          gasPrice: getGasPrice()
        });

      await Promise.all([
        dispatch('fetchCharacter', { characterId: id }),
      ]);
    },

    async fetchTotalCharacterWaterTraitChanges({ state }) {
      const { CharacterWaterTraitChangeConsumables } = state.contracts();
      if(!CharacterWaterTraitChangeConsumables || !state.defaultAccount) return;
      return await CharacterWaterTraitChangeConsumables.methods.getItemCount().call(defaultCallOptions(state));
    },
    async changeCharacterTraitWater({ state, dispatch}, { id }) {
      const { CryptoBlades, SkillToken, CharacterWaterTraitChangeConsumables } = state.contracts();
      if(!CryptoBlades || !SkillToken || !CharacterWaterTraitChangeConsumables || !state.defaultAccount) return;

      await CharacterWaterTraitChangeConsumables.methods
        .changeCharacterTrait(id)
        .send({
          from: state.defaultAccount,
          gas: '5000000',
          gasPrice: getGasPrice()
        });

      await Promise.all([
        dispatch('fetchCharacter', { characterId: id }),
      ]);
    },

    async fetchTotalCharacterLightningTraitChanges({ state }) {
      const { CharacterLightningTraitChangeConsumables } = state.contracts();
      if(!CharacterLightningTraitChangeConsumables || !state.defaultAccount) return;
      return await CharacterLightningTraitChangeConsumables.methods.getItemCount().call(defaultCallOptions(state));
    },
    async changeCharacterTraitLightning({ state, dispatch}, { id }) {
      const { CryptoBlades, SkillToken, CharacterLightningTraitChangeConsumables } = state.contracts();
      if(!CryptoBlades || !SkillToken || !CharacterLightningTraitChangeConsumables || !state.defaultAccount) return;

      await CharacterLightningTraitChangeConsumables.methods
        .changeCharacterTrait(id)
        .send({
          from: state.defaultAccount,
          gas: '5000000',
          gasPrice: getGasPrice()
        });

      await Promise.all([
        dispatch('fetchCharacter', { characterId: id }),
      ]);
    },
    async fetchOwnedWeaponCosmetics({ state }, {cosmetic}) {
      const { WeaponCosmetics } = state.contracts();
      if(!WeaponCosmetics || !state.defaultAccount) return;
      return await WeaponCosmetics.methods.getCosmeticCount(cosmetic).call(defaultCallOptions(state));
    },
    async changeWeaponCosmetic({ state, dispatch}, { id, cosmetic }) {
      const { CryptoBlades, SkillToken, WeaponCosmetics } = state.contracts();
      if(!CryptoBlades || !SkillToken || !WeaponCosmetics || !state.defaultAccount) return;

      await WeaponCosmetics.methods
        .applyCosmetic(id, cosmetic)
        .send({
          from: state.defaultAccount,
          gas: '5000000',
          gasPrice: getGasPrice()
        });

      await Promise.all([
        dispatch('fetchWeaponCosmetic', id)
      ]);
    },
    async removeWeaponCosmetic({ state, dispatch}, { id }) {
      const { CryptoBlades, SkillToken, WeaponCosmetics } = state.contracts();
      if(!CryptoBlades || !SkillToken || !WeaponCosmetics || !state.defaultAccount) return;

      await WeaponCosmetics.methods
        .removeCosmetic(id)
        .send({
          from: state.defaultAccount,
          gas: '5000000',
          gasPrice: getGasPrice()
        });

      await Promise.all([
        dispatch('fetchWeaponCosmetic', id)
      ]);
    },
    async fetchOwnedCharacterCosmetics({ state }, {cosmetic}) {
      const { CharacterCosmetics } = state.contracts();
      if(!CharacterCosmetics || !state.defaultAccount) return;
      return await CharacterCosmetics.methods.getCosmeticCount(cosmetic).call(defaultCallOptions(state));
    },
    async changeCharacterCosmetic({ state, dispatch}, { id, cosmetic }) {
      const { CryptoBlades, SkillToken, CharacterCosmetics } = state.contracts();
      if(!CryptoBlades || !SkillToken || !CharacterCosmetics || !state.defaultAccount) return;

      await CharacterCosmetics.methods
        .applyCosmetic(id, cosmetic)
        .send({
          from: state.defaultAccount,
          gas: '5000000',
          gasPrice: getGasPrice()
        });

      await Promise.all([
        dispatch('fetchCharacterCosmetic', id)
      ]);
    },
    async removeCharacterCosmetic({ state, dispatch}, { id }) {
      const { CryptoBlades, SkillToken, CharacterCosmetics } = state.contracts();
      if(!CryptoBlades || !SkillToken || !CharacterCosmetics || !state.defaultAccount) return;

      await CharacterCosmetics.methods
        .removeCosmetic(id)
        .send({
          from: state.defaultAccount,
          gas: '5000000',
          gasPrice: getGasPrice()
        });

      await Promise.all([
        dispatch('fetchCharacterCosmetic', id)
      ]);
    },

    async configureMetaMask({ state, dispatch }) {
      const currentNetwork = await state.web3.eth.net.getId();
      if(currentNetwork === +getConfigValue('VUE_APP_NETWORK_ID')) return;
      dispatch('configureChainNet', {
        networkId: +getConfigValue('VUE_APP_NETWORK_ID'),
        chainId: getConfigValue('chainId'),
        chainName: getConfigValue('VUE_APP_EXPECTED_NETWORK_NAME'),
        currencyName: getConfigValue('currencyName'),
        currencySymbol: getConfigValue('currencySymbol'),
        currencyDecimals: +getConfigValue('currencyDecimals'),
        rpcUrls: getConfigValue('rpcUrls'),
        blockExplorerUrls: getConfigValue('blockExplorerUrls'),
        skillAddress: getConfigValue('VUE_APP_SKILL_TOKEN_CONTRACT_ADDRESS')
      });
    },
    async configureChainNet(
      { state, commit },
      { networkId, chainId, chainName, currencyName, currencySymbol, currencyDecimals, rpcUrls, blockExplorerUrls, skillAddress }:
      { networkId: number,
        chainId: string,
        chainName: string,
        currencyName: string,
        currencySymbol: string,
        currencyDecimals: number,
        rpcUrls: string[],
        blockExplorerUrls: string[],
        skillAddress: string,
      })
    {
      commit('setNetworkId', networkId);
      try {
        await (state.web3.currentProvider as any).request({
          method: 'wallet_switchEthereumChain',
          params: [{ chainId }],
        });
      } catch (switchError) {
        try {
          await (state.web3.currentProvider as any).request({
            method: 'wallet_addEthereumChain',
            params: [
              {
                chainId,
                chainName,
                nativeCurrency: {
                  name: currencyName,
                  symbol: currencySymbol,
                  decimals: currencyDecimals,
                },
                rpcUrls,
                blockExplorerUrls,
              },
            ],
          });
        } catch (addError) {
          console.error(addError);
          return;
        }
      }

      try {
        await (state.web3.currentProvider as any).request({
          method: 'wallet_watchAsset',
          params: {
            type: 'ERC20',
            options: {
              address: skillAddress,
              symbol: 'SKILL',
              decimals: 18,
              image: 'https://app.cryptoblades.io/android-chrome-512x512.png',
            },
          },
        });
      } catch (error) {
        console.error(error);
      }

      window.location.reload();
    },
    async transferNFT({ state, dispatch },{nftId, receiverAddress, nftType}: {nftId: number, receiverAddress: string, nftType: string}) {
      const { Characters, Garrison, Junk, KeyLootbox, RaidTrinket, Shields, Weapons } = state.contracts();
      if (!Characters || !Garrison || !Junk || !KeyLootbox || !RaidTrinket || !Shields || !Weapons || !state.defaultAccount) return;

      if (nftType === 'character') {
        if (state.ownedGarrisonCharacterIds.includes(nftId)) {
          await Garrison.methods
            .transferFromGarrison(receiverAddress, nftId)
            .send({
              from: state.defaultAccount,
              gasPrice: getGasPrice()
            });
        }
        else {
          await Characters.methods
            .safeTransferFrom(state.defaultAccount, receiverAddress, nftId)
            .send({
              from: state.defaultAccount,
              gasPrice: getGasPrice()
            });
        }
        await dispatch('updateCharacterIds');
      }
      else if (nftType === 'junk') {
        await Junk.methods
          .safeTransferFrom(state.defaultAccount, receiverAddress, nftId)
          .send({
            from: state.defaultAccount,
            gasPrice: getGasPrice(),
          });
        await dispatch('updateJunkIds');
      }
      else if (nftType === 'keybox') {
        await KeyLootbox.methods
          .safeTransferFrom(state.defaultAccount, receiverAddress, nftId)
          .send({
            from: state.defaultAccount,
            gasPrice: getGasPrice(),
          });
        await dispatch('updateKeyLootboxIds');
      }
      else if (nftType === 'shield') {
        await Shields.methods
          .safeTransferFrom(state.defaultAccount, receiverAddress, nftId)
          .send({
            from: state.defaultAccount,
            gasPrice: getGasPrice(),
          });
        await dispatch('updateShieldIds');
      }
      else if (nftType === 'trinket') {
        await RaidTrinket.methods
          .safeTransferFrom(state.defaultAccount, receiverAddress, nftId)
          .send({
            from: state.defaultAccount,
            gasPrice: getGasPrice(),
          });
        await dispatch('updateTrinketIds');
      }
      else if (nftType === 'weapon') {
        await Weapons.methods
          .safeTransferFrom(state.defaultAccount, receiverAddress, nftId)
          .send({
            from: state.defaultAccount,
            gasPrice: getGasPrice(),
          });
        await dispatch('updateWeaponIds');
      }
    },

    async restoreFromGarrison({ state, dispatch }, characterId) {
      const { Garrison } = state.contracts();
      if(!Garrison || !state.defaultAccount) return;

      await Garrison.methods.restoreFromGarrison(characterId).send({ from: state.defaultAccount, gasPrice: getGasPrice() });
      await dispatch('updateCharacterIds');
    },

    async sendToGarrison({ state, dispatch }, characterId) {
      const { Garrison, Characters } = state.contracts();
      if(!Garrison || !Characters || !state.defaultAccount) return;

      await Characters.methods.approve(Garrison.options.address, characterId).send(defaultCallOptions(state));
      await Garrison.methods.sendToGarrison(characterId).send({ from: state.defaultAccount, gasPrice: getGasPrice(), });
      await dispatch('updateCharacterIds');
    },

    async getWeapon({ state }, weaponId) {
      const { Weapons } = state.contracts();
      if (!Weapons || !state.defaultAccount) return;

      return await Weapons.methods.get(`${weaponId}`).call({from: state.defaultAccount, gasPrice: getGasPrice()});
    },

    async getShield({ state }, shieldId) {
      const { Shields } = state.contracts();
      if (!Shields || !state.defaultAccount) return;

      return await Shields.methods.get(`${shieldId}`).call({from: state.defaultAccount, gasPrice: getGasPrice()});
    },

    async getCharacter({ state }, characterId) {
      const { Characters } = state.contracts();
      if (!Characters || !state.defaultAccount) return;

      return await Characters.methods.get(`${characterId}`).call({from: state.defaultAccount, gasPrice: getGasPrice()});
    },

    async getRename({state}, characterId){
      const { CharacterRenameTagConsumables } = state.contracts();

      const characterRename = await CharacterRenameTagConsumables?.methods.getCharacterRename(characterId).call({
        from: state.defaultAccount,
        gasPrice: getGasPrice()
      });

      if(characterRename !== '') return characterRename;
      return;
    },

    async getCharacterPower({ state }, characterId) {
      const { Characters } = state.contracts();
      if (!Characters || !state.defaultAccount) return;

      return await Characters.methods.getPower(characterId).call({from: state.defaultAccount, gasPrice: getGasPrice()});
    },

    async burnCharactersIntoCharacter({ state, dispatch }, {burnIds, targetId}) {
      const { CryptoBlades, BurningManager, SkillToken } = state.contracts();
      if(!CryptoBlades || !BurningManager || !SkillToken || !state.defaultAccount) return;

      const burnCost = await BurningManager.methods.burnCharactersFee(burnIds).call(defaultCallOptions(state));
      await approveFeeFixed(
        CryptoBlades,
        CryptoBlades,
        SkillToken,
        state.defaultAccount,
        state.skillRewards,
        defaultCallOptions(state),
        defaultCallOptions(state),
        new BigNumber(burnCost),
        { allowSkillRewards: true, allowInGameOnlyFunds: false }
      );

      await BurningManager.methods.burnCharactersIntoCharacter(burnIds, targetId).send({ from: state.defaultAccount, gasPrice: getGasPrice() });
      await Promise.all([
        dispatch('updateCharacterIds'),
        dispatch('fetchSkillBalance')
      ]);
    },

    async burnCharactersIntoSoul({ state, dispatch }, burnIds) {
      const { CryptoBlades, BurningManager, SkillToken } = state.contracts();
      if(!CryptoBlades || !BurningManager || !SkillToken || !state.defaultAccount) return;

      const burnCost = await BurningManager.methods.burnCharactersFee(burnIds).call(defaultCallOptions(state));
      await approveFeeFixed(
        CryptoBlades,
        CryptoBlades,
        SkillToken,
        state.defaultAccount,
        state.skillRewards,
        defaultCallOptions(state),
        defaultCallOptions(state),
        new BigNumber(burnCost),
        { allowSkillRewards: true, allowInGameOnlyFunds: false }
      );

      await BurningManager.methods.burnCharactersIntoSoul(burnIds).send({ from: state.defaultAccount, gasPrice: getGasPrice() });
      await Promise.all([
        dispatch('updateCharacterIds'),
        dispatch('fetchSkillBalance')
      ]);
    },

    async upgradeCharacterWithSoul({ state, dispatch }, {charId, soulAmount}) {
      const { BurningManager } = state.contracts();
      if(!BurningManager || !state.defaultAccount) return;

      await BurningManager.methods.upgradeCharacterWithSoul(charId, soulAmount).send({ from: state.defaultAccount, gasPrice: getGasPrice() });
      await dispatch('fetchCharacterPower', charId);
    },

    async transferSoul({ state }, {targetAddress, soulAmount}) {
      const { BurningManager } = state.contracts();
      if(!BurningManager || !state.defaultAccount) return;

      await BurningManager.methods.transferSoul(targetAddress, soulAmount).send({ from: state.defaultAccount, gasPrice: getGasPrice() });
    },

    async fetchCharactersBurnCost({ state }, burnIds) {
      const { BurningManager } = state.contracts();
      if(!BurningManager || !state.defaultAccount) return;

      return await BurningManager.methods.burnCharactersFee(burnIds).call(defaultCallOptions(state));
    },

    async fetchBurnPowerMultiplier({ state }) {
      const { BurningManager } = state.contracts();
      if(!BurningManager || !state.defaultAccount) return;

      return await BurningManager.methods.vars(2).call(defaultCallOptions(state));
    },

    async getBurnPointMultiplier({ state }) {
      const { Weapons } = state.contracts();
      if(!Weapons || !state.defaultAccount) return;

      return await Weapons.methods.burnPointMultiplier().call(defaultCallOptions(state));
    },

    async setBurnPointMultiplier({state}, {multiplier}) {
      const { Weapons } = state.contracts();
      if(!Weapons || !state.defaultAccount) return;

      await Weapons.methods.setBurnPointMultiplier(multiplier).send({ from: state.defaultAccount, gasPrice: getGasPrice() });
    },

    async fetchMintWeaponPriceDecreasePerSecond({state}) {
      const { CryptoBlades } = state.contracts();
      if(!CryptoBlades || !state.defaultAccount) return;

      const decreaseRaw = await CryptoBlades.methods.vars(19).call(defaultCallOptions(state));
      const decreaseBN = new BigNumber(decreaseRaw).multipliedBy(new BigNumber(2).pow(64)).toString();

      const decreaseInSkill = await CryptoBlades.methods.usdToSkill(decreaseBN).call(defaultCallOptions(state));
      return new BigNumber(decreaseInSkill).div(1e18);
    },

    async fetchMintCharacterPriceDecreasePerSecond({state}) {
      const { CryptoBlades } = state.contracts();
      if(!CryptoBlades || !state.defaultAccount) return;

      const decreaseRaw = await CryptoBlades.methods.vars(20).call(defaultCallOptions(state));
      const decreaseBN = new BigNumber(decreaseRaw).multipliedBy(new BigNumber(2).pow(64)).toString();

      const decreaseInSkill = await CryptoBlades.methods.usdToSkill(decreaseBN).call(defaultCallOptions(state));
      return new BigNumber(decreaseInSkill).div(1e18);
    },

    async fetchWeaponMintIncreasePrice({state}) {
      const { CryptoBlades } = state.contracts();
      if(!CryptoBlades || !state.defaultAccount) return;

      const increaseRaw = await CryptoBlades.methods.vars(21).call(defaultCallOptions(state));
      const increaseBN = new BigNumber(increaseRaw).multipliedBy(new BigNumber(2).pow(64)).toString();

      const increaseInSkill = await CryptoBlades.methods.usdToSkill(increaseBN).call(defaultCallOptions(state));
      return new BigNumber(increaseInSkill).div(1e18);
    },

    async fetchCharacterMintIncreasePrice({state}) {
      const { CryptoBlades } = state.contracts();
      if(!CryptoBlades || !state.defaultAccount) return;

      const increaseRaw = await CryptoBlades.methods.vars(22).call(defaultCallOptions(state));
      const increaseBN = new BigNumber(increaseRaw).multipliedBy(new BigNumber(2).pow(64)).toString();

      const increaseInSkill = await CryptoBlades.methods.usdToSkill(increaseBN).call(defaultCallOptions(state));
      return new BigNumber(increaseInSkill).div(1e18);
    },

    async fetchMintWeaponMinPrice({state}) {
      const { CryptoBlades } = state.contracts();
      if(!CryptoBlades || !state.defaultAccount) return;

      const priceInUsdRaw = await CryptoBlades.methods.vars(23).call(defaultCallOptions(state));
      const priceInUsd = new BigNumber(priceInUsdRaw).multipliedBy(new BigNumber(2).pow(64)).div(100).toString();
      return await CryptoBlades.methods.usdToSkill(priceInUsd).call(defaultCallOptions(state));
    },

    async fetchMintCharacterMinPrice({state}) {
      const { CryptoBlades } = state.contracts();
      if(!CryptoBlades || !state.defaultAccount) return;

      const priceInUsdRaw = await CryptoBlades.methods.vars(24).call(defaultCallOptions(state));
      const priceInUsd = new BigNumber(priceInUsdRaw).multipliedBy(new BigNumber(2).pow(64)).div(100).toString();
      return await CryptoBlades.methods.usdToSkill(priceInUsd).call(defaultCallOptions(state));
    },

    async fetchMintWeaponFee({state}) {
      const { CryptoBlades } = state.contracts();
      if(!CryptoBlades || !state.defaultAccount) return 0;

      return CryptoBlades.methods.getMintWeaponFee().call(defaultCallOptions(state));
    },

    async fetchMintCharacterFee({state}) {
      const { CryptoBlades } = state.contracts();
      if(!CryptoBlades || !state.defaultAccount) return;

      return CryptoBlades.methods.getMintCharacterFee().call(defaultCallOptions(state));
    },

    async getCurrentSkillPrice({ state }) {
      const { TokensManager } = state.contracts();
      if (!TokensManager || !state.defaultAccount) return;

      return await TokensManager.methods.skillTokenPrice().call(defaultCallOptions(state));
    },

    async getNativeTokenPriceInUsd({ state }) {
      const { TokensManager } = state.contracts();
      if (!TokensManager || !state.defaultAccount) return;

      return await TokensManager.methods.tokenPrice().call(defaultCallOptions(state));
    },

    async doEncounterPayNative({ state, dispatch }, { characterId, weaponId, targetString, fightMultiplier, offsetCost }) {
      const { TokensManager, CryptoBlades } = state.contracts();
      if (!TokensManager || !CryptoBlades || !state.defaultAccount) return;

      const res = await TokensManager.methods
        .fight(
          characterId,
          weaponId,
          targetString,
          fightMultiplier
        )
        .send({ from: state.defaultAccount, gasPrice: getGasPrice(), gas: '300000', value: (+offsetCost ? +offsetCost : 1)*fightMultiplier });

      let playerRoll = '';
      let enemyRoll = '';
      let xpGain;
      let skillGain;

      const fightOutcomeEvents = await CryptoBlades.getPastEvents('FightOutcome', {
        filter: { owner: state.defaultAccount!, character: characterId },
        toBlock: res.blockNumber,
        fromBlock: res.blockNumber
      });

      if (fightOutcomeEvents.length) {
        playerRoll = fightOutcomeEvents[fightOutcomeEvents.length - 1].returnValues.playerRoll;
        enemyRoll = fightOutcomeEvents[fightOutcomeEvents.length - 1].returnValues.enemyRoll;
        xpGain = fightOutcomeEvents[fightOutcomeEvents.length - 1].returnValues.xpGain;
        skillGain = fightOutcomeEvents[fightOutcomeEvents.length - 1].returnValues.skillGain;
      }

      const {gasPrice} = await state.web3.eth.getTransaction(res.transactionHash);

      const bnbGasUsed = gasUsedToBnb(res.gasUsed, gasPrice);
      await dispatch('fetchTargets', { characterId, weaponId });
      await dispatch('fetchWeaponDurability', weaponId);

      return {
        isVictory: parseInt(playerRoll, 10) >= parseInt(enemyRoll, 10),
        playerRoll,
        enemyRoll,
        xpGain,
        skillGain,
        bnbGasUsed
      };
    },

    async getCombatTokenChargePercent({ state }) {
      const { TokensManager } = state.contracts();
      if(!TokensManager || !state.defaultAccount) return;

      return await TokensManager.methods
        .combatTokenChargePercent()
        .call(defaultCallOptions(state));
    },
  }
});
