import { describe, expect, it, vi, beforeEach } from "vitest";

// Interfaces for type safety
interface ClarityResponse<T> {
  ok: boolean;
  value: T | number; // number for error codes
}

interface VerificationQueueEntry {
  status: string;
  startHeight: number;
  yesVotes: number;
  noVotes: number;
  totalStake: number;
  voters: string[];
}

interface VoteEntry {
  vote: boolean;
  stake: number;
  timestamp: number;
}

interface DisputeEntry {
  note: string;
  timestamp: number;
  resolved: boolean;
}

interface VerificationHistoryEntry {
  status: string;
  note: string;
  timestamp: number;
  verifierCount: number;
  totalStake: number;
}

interface ContractState {
  verificationQueue: Map<string, VerificationQueueEntry>;
  votes: Map<string, VoteEntry>;
  disputes: Map<string, DisputeEntry>;
  verificationHistory: Map<string, VerificationHistoryEntry>;
  verificationIdCounter: number;
  blockHeight: number;
  admin: string;
}

// Mock contract implementation
class ContentVerificationMock {
  private state: ContractState = {
    verificationQueue: new Map(),
    votes: new Map(),
    disputes: new Map(),
    verificationHistory: new Map(),
    verificationIdCounter: 0,
    blockHeight: 1000,
    admin: "deployer",
  };

  private MAX_VOTERS = 50;
  private MIN_STAKE = 1000;
  private VOTING_PERIOD = 1440;
  private MAX_DISPUTE_NOTE_LEN = 200;
  private MAX_VERIFICATION_NOTE_LEN = 200;
  private VERIFICATION_THRESHOLD = 70;
  private ERR_UNAUTHORIZED = 100;
  private ERR_INVALID_HASH = 101;
  private ERR_ALREADY_VERIFIED = 102;
  private ERR_VOTING_CLOSED = 103;
  private ERR_INSUFFICIENT_STAKE = 104;
  private ERR_INVALID_VOTE = 105;
  private ERR_INVALID_DISPUTE = 106;
  private ERR_NOT_REGISTERED = 107;
  private ERR_MAX_VOTERS = 108;
  private ERR_ALREADY_VOTED = 110;

  // Mock contract-call to content-registry
  private isContentRegistered(contentHash: string): boolean {
    return contentHash !== "invalid";
  }

  // Mock contract-call to governance
  private isAdmin(caller: string): boolean {
    return caller === this.state.admin;
  }

  // Mock stx-transfer
  private stxTransfer(amount: number, sender: string, recipient: string): ClarityResponse<boolean> {
    return { ok: true, value: true };
  }

  // Mock update-content-status
  private updateContentStatus(contentHash: string, status: string, visibility: boolean): ClarityResponse<boolean> {
    return { ok: true, value: true };
  }

  addToVerificationQueue(contentHash: string): ClarityResponse<boolean> {
    if (!this.isContentRegistered(contentHash)) {
      return { ok: false, value: this.ERR_NOT_REGISTERED };
    }
    if (this.state.verificationQueue.has(contentHash)) {
      return { ok: false, value: this.ERR_ALREADY_VERIFIED };
    }
    this.state.verificationQueue.set(contentHash, {
      status: "pending",
      startHeight: this.state.blockHeight,
      yesVotes: 0,
      noVotes: 0,
      totalStake: 0,
      voters: [],
    });
    return { ok: true, value: true };
  }

  voteOnContent(contentHash: string, voter: string, vote: boolean, stake: number): ClarityResponse<boolean> {
    const queueEntry = this.state.verificationQueue.get(contentHash);
    if (!queueEntry) {
      return { ok: false, value: this.ERR_NOT_REGISTERED };
    }
    if (queueEntry.status !== "pending" || this.state.blockHeight >= queueEntry.startHeight + this.VOTING_PERIOD) {
      return { ok: false, value: this.ERR_VOTING_CLOSED };
    }
    if (this.state.votes.has(`${contentHash}-${voter}`)) {
      return { ok: false, value: this.ERR_ALREADY_VOTED };
    }
    if (stake < this.MIN_STAKE) {
      return { ok: false, value: this.ERR_INSUFFICIENT_STAKE };
    }
    if (queueEntry.voters.length >= this.MAX_VOTERS) {
      return { ok: false, value: this.ERR_MAX_VOTERS };
    }
    const transferResult = this.stxTransfer(stake, voter, "contract");
    if (!transferResult.ok) {
      return transferResult;
    }
    this.state.votes.set(`${contentHash}-${voter}`, {
      vote,
      stake,
      timestamp: this.state.blockHeight,
    });
    this.state.verificationQueue.set(contentHash, {
      ...queueEntry,
      yesVotes: vote ? queueEntry.yesVotes + 1 : queueEntry.yesVotes,
      noVotes: !vote ? queueEntry.noVotes + 1 : queueEntry.noVotes,
      totalStake: queueEntry.totalStake + stake,
      voters: [...queueEntry.voters, voter],
    });
    return { ok: true, value: true };
  }

  finalizeVerification(contentHash: string, caller: string, note: string): ClarityResponse<boolean> {
    if (!this.isAdmin(caller)) {
      return { ok: false, value: this.ERR_UNAUTHORIZED };
    }
    const queueEntry = this.state.verificationQueue.get(contentHash);
    if (!queueEntry) {
      return { ok: false, value: this.ERR_NOT_REGISTERED };
    }
    if (queueEntry.status !== "pending" || this.state.blockHeight < queueEntry.startHeight + this.VOTING_PERIOD) {
      return { ok: false, value: this.ERR_VOTING_CLOSED };
    }
    if (note.length > this.MAX_VERIFICATION_NOTE_LEN) {
      return { ok: false, value: this.ERR_INVALID_DISPUTE };
    }
    const totalVotes = queueEntry.yesVotes + queueEntry.noVotes;
    const result = totalVotes === 0 ? false : (queueEntry.yesVotes * 100) / totalVotes >= this.VERIFICATION_THRESHOLD;
    const newStatus = result ? "verified" : "rejected";
    this.state.verificationQueue.set(contentHash, { ...queueEntry, status: newStatus });
    const verId = this.state.verificationIdCounter;
    this.state.verificationHistory.set(`${contentHash}-${verId}`, {
      status: newStatus,
      note,
      timestamp: this.state.blockHeight,
      verifierCount: totalVotes,
      totalStake: queueEntry.totalStake,
    });
    this.state.verificationIdCounter += 1;
    const updateResult = this.updateContentStatus(contentHash, newStatus, true);
    if (!updateResult.ok) {
      return updateResult;
    }
    return { ok: true, value: true };
  }

  raiseDispute(contentHash: string, disputer: string, note: string): ClarityResponse<boolean> {
    const queueEntry = this.state.verificationQueue.get(contentHash);
    if (!queueEntry) {
      return { ok: false, value: this.ERR_NOT_REGISTERED };
    }
    if (queueEntry.status !== "verified") {
      return { ok: false, value: this.ERR_INVALID_DISPUTE };
    }
    if (note.length > this.MAX_DISPUTE_NOTE_LEN) {
      return { ok: false, value: this.ERR_INVALID_DISPUTE };
    }
    this.state.disputes.set(`${contentHash}-${disputer}`, {
      note,
      timestamp: this.state.blockHeight,
      resolved: false,
    });
    return { ok: true, value: true };
  }

  resolveDispute(contentHash: string, disputer: string, caller: string, resolveStatus: boolean, note: string): ClarityResponse<boolean> {
    if (!this.isAdmin(caller)) {
      return { ok: false, value: this.ERR_UNAUTHORIZED };
    }
    const disputeEntry = this.state.disputes.get(`${contentHash}-${disputer}`);
    if (!disputeEntry || disputeEntry.resolved) {
      return { ok: false, value: this.ERR_INVALID_DISPUTE };
    }
    if (note.length > this.MAX_VERIFICATION_NOTE_LEN) {
      return { ok: false, value: this.ERR_INVALID_DISPUTE };
    }
    this.state.disputes.set(`${contentHash}-${disputer}`, { ...disputeEntry, resolved: true });
    if (resolveStatus) {
      const queueEntry = this.state.verificationQueue.get(contentHash);
      if (queueEntry) {
        this.state.verificationQueue.set(contentHash, { ...queueEntry, status: "pending" });
      }
      const updateResult = this.updateContentStatus(contentHash, "pending", false);
      if (!updateResult.ok) {
        return updateResult;
      }
    }
    return { ok: true, value: true };
  }

  getVerificationStatus(contentHash: string): ClarityResponse<VerificationQueueEntry | null> {
    return { ok: true, value: this.state.verificationQueue.get(contentHash) ?? null };
  }

  getVoteDetails(contentHash: string, voter: string): ClarityResponse<VoteEntry | null> {
    return { ok: true, value: this.state.votes.get(`${contentHash}-${voter}`) ?? null };
  }

  getDisputeDetails(contentHash: string, disputer: string): ClarityResponse<DisputeEntry | null> {
    return { ok: true, value: this.state.disputes.get(`${contentHash}-${disputer}`) ?? null };
  }

  getVerificationHistory(contentHash: string, verificationId: number): ClarityResponse<VerificationHistoryEntry | null> {
    return { ok: true, value: this.state.verificationHistory.get(`${contentHash}-${verificationId}`) ?? null };
  }
}

// Test setup
const accounts = {
  deployer: "deployer",
  voter1: "wallet_1",
  voter2: "wallet_2",
  disputer: "wallet_3",
  nonAdmin: "wallet_4",
};

describe("ContentVerification Contract", () => {
  let contract: ContentVerificationMock;

  beforeEach(() => {
    contract = new ContentVerificationMock();
    vi.resetAllMocks();
  });

  it("should add content to verification queue", () => {
    const result = contract.addToVerificationQueue("hash1");
    expect(result).toEqual({ ok: true, value: true });
    expect(contract.getVerificationStatus("hash1")).toEqual({
      ok: true,
      value: expect.objectContaining({
        status: "pending",
        startHeight: 1000,
        yesVotes: 0,
        noVotes: 0,
        totalStake: 0,
        voters: [],
      }),
    });
  });

  it("should prevent adding unregistered content", () => {
    const result = contract.addToVerificationQueue("invalid");
    expect(result).toEqual({ ok: false, value: 107 });
  });

  it("should prevent adding already queued content", () => {
    contract.addToVerificationQueue("hash1");
    const result = contract.addToVerificationQueue("hash1");
    expect(result).toEqual({ ok: false, value: 102 });
  });

  it("should allow voting on content", () => {
    contract.addToVerificationQueue("hash1");
    const result = contract.voteOnContent("hash1", accounts.voter1, true, 1000);
    expect(result).toEqual({ ok: true, value: true });
    expect(contract.getVoteDetails("hash1", accounts.voter1)).toEqual({
      ok: true,
      value: expect.objectContaining({
        vote: true,
        stake: 1000,
        timestamp: 1000,
      }),
    });
    expect(contract.getVerificationStatus("hash1")).toEqual({
      ok: true,
      value: expect.objectContaining({
        yesVotes: 1,
        noVotes: 0,
        totalStake: 1000,
        voters: [accounts.voter1],
      }),
    });
  });

  it("should prevent voting with insufficient stake", () => {
    contract.addToVerificationQueue("hash1");
    const result = contract.voteOnContent("hash1", accounts.voter1, true, 500);
    expect(result).toEqual({ ok: false, value: 104 });
  });

  it("should prevent voting on closed voting period", () => {
    contract.addToVerificationQueue("hash1");
    contract.state.blockHeight = 2500; // Beyond VOTING_PERIOD
    const result = contract.voteOnContent("hash1", accounts.voter1, true, 1000);
    expect(result).toEqual({ ok: false, value: 103 });
  });

  it("should prevent double voting", () => {
    contract.addToVerificationQueue("hash1");
    contract.voteOnContent("hash1", accounts.voter1, true, 1000);
    const result = contract.voteOnContent("hash1", accounts.voter1, true, 1000);
    expect(result).toEqual({ ok: false, value: 110 });
  });

  it("should prevent voting when max voters reached", () => {
    contract.addToVerificationQueue("hash1");
    const queueEntry = contract.state.verificationQueue.get("hash1")!;
    queueEntry.voters = new Array(50).fill(accounts.voter1);
    contract.state.verificationQueue.set("hash1", queueEntry);
    const result = contract.voteOnContent("hash1", accounts.voter2, true, 1000);
    expect(result).toEqual({ ok: false, value: 108 });
  });

  it("should finalize verification with sufficient votes", () => {
    contract.addToVerificationQueue("hash1");
    contract.voteOnContent("hash1", accounts.voter1, true, 1000);
    contract.voteOnContent("hash1", accounts.voter2, true, 1000);
    contract.state.blockHeight = 2500; // Voting period ends
    const result = contract.finalizeVerification("hash1", accounts.deployer, "Approved by community");
    expect(result).toEqual({ ok: true, value: true });
    expect(contract.getVerificationStatus("hash1")).toEqual({
      ok: true,
      value: expect.objectContaining({ status: "verified" }),
    });
    expect(contract.getVerificationHistory("hash1", 0)).toEqual({
      ok: true,
      value: expect.objectContaining({
        status: "verified",
        note: "Approved by community",
        verifierCount: 2,
        totalStake: 2000,
      }),
    });
  });

  it("should reject content with insufficient votes", () => {
    contract.addToVerificationQueue("hash1");
    contract.voteOnContent("hash1", accounts.voter1, true, 1000);
    contract.voteOnContent("hash1", accounts.voter2, false, 1000);
    contract.state.blockHeight = 2500; // Voting period ends
    const result = contract.finalizeVerification("hash1", accounts.deployer, "Insufficient approval");
    expect(result).toEqual({ ok: true, value: true });
    expect(contract.getVerificationStatus("hash1")).toEqual({
      ok: true,
      value: expect.objectContaining({ status: "rejected" }),
    });
  });

  it("should prevent non-admin from finalizing", () => {
    contract.addToVerificationQueue("hash1");
    contract.state.blockHeight = 2500;
    const result = contract.finalizeVerification("hash1", accounts.nonAdmin, "Unauthorized");
    expect(result).toEqual({ ok: false, value: 100 });
  });

  it("should prevent finalizing before voting period ends", () => {
    contract.addToVerificationQueue("hash1");
    const result = contract.finalizeVerification("hash1", accounts.deployer, "Too early");
    expect(result).toEqual({ ok: false, value: 103 });
  });

  it("should allow raising a dispute on verified content", () => {
    contract.addToVerificationQueue("hash1");
    contract.voteOnContent("hash1", accounts.voter1, true, 1000);
    contract.state.blockHeight = 2500;
    contract.finalizeVerification("hash1", accounts.deployer, "Approved");
    const result = contract.raiseDispute("hash1", accounts.disputer, "Content has errors");
    expect(result).toEqual({ ok: true, value: true });
    expect(contract.getDisputeDetails("hash1", accounts.disputer)).toEqual({
      ok: true,
      value: expect.objectContaining({
        note: "Content has errors",
        resolved: false,
      }),
    });
  });

  it("should prevent dispute on non-verified content", () => {
    contract.addToVerificationQueue("hash1");
    const result = contract.raiseDispute("hash1", accounts.disputer, "Invalid");
    expect(result).toEqual({ ok: false, value: 106 });
  });

  it("should allow admin to resolve dispute", () => {
    contract.addToVerificationQueue("hash1");
    contract.voteOnContent("hash1", accounts.voter1, true, 1000);
    contract.state.blockHeight = 2500;
    contract.finalizeVerification("hash1", accounts.deployer, "Approved");
    contract.raiseDispute("hash1", accounts.disputer, "Content has errors");
    const result = contract.resolveDispute("hash1", accounts.disputer, accounts.deployer, true, "Dispute valid");
    expect(result).toEqual({ ok: true, value: true });
    expect(contract.getDisputeDetails("hash1", accounts.disputer)).toEqual({
      ok: true,
      value: expect.objectContaining({ resolved: true }),
    });
    expect(contract.getVerificationStatus("hash1")).toEqual({
      ok: true,
      value: expect.objectContaining({ status: "pending" }),
    });
  });

  it("should prevent non-admin from resolving dispute", () => {
    contract.addToVerificationQueue("hash1");
    contract.voteOnContent("hash1", accounts.voter1, true, 1000);
    contract.state.blockHeight = 2500;
    contract.finalizeVerification("hash1", accounts.deployer, "Approved");
    contract.raiseDispute("hash1", accounts.disputer, "Content has errors");
    const result = contract.resolveDispute("hash1", accounts.disputer, accounts.nonAdmin, true, "Unauthorized");
    expect(result).toEqual({ ok: false, value: 100 });
  });

  it("should prevent resolving already resolved dispute", () => {
    contract.addToVerificationQueue("hash1");
    contract.voteOnContent("hash1", accounts.voter1, true, 1000);
    contract.state.blockHeight = 2500;
    contract.finalizeVerification("hash1", accounts.deployer, "Approved");
    contract.raiseDispute("hash1", accounts.disputer, "Content has errors");
    contract.resolveDispute("hash1", accounts.disputer, accounts.deployer, true, "Dispute valid");
    const result = contract.resolveDispute("hash1", accounts.disputer, accounts.deployer, true, "Already resolved");
    expect(result).toEqual({ ok: false, value: 106 });
  });
});