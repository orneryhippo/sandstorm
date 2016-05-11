import { Meteor } from "meteor/meteor";
import { Router } from "meteor/iron:router";
import { Random } from "meteor/random";
import Crypto from "crypto";
import Fs from "fs";

const hashSessionId = function (sessionId) {
  return Crypto.createHash("sha256").update(sessionId).digest("base64");
};

// An in-memory map of random id -> timestamp, used to authorize requests to download the system
// log.
const SYSTEM_LOG_DOWNLOAD_TOKENS = {};

Meteor.methods({
  adminGetServerLogDownloadToken() {
    const db = this.connection.sandstormDb;
    if (!db.isAdminById(this.userId)) {
      throw new Meteor.Error(403, "User must be admin to download system log.");
    }

    const token = Random.id();
    SYSTEM_LOG_DOWNLOAD_TOKENS[token] = Date.now();
    return token;
  },
});

Router.map(function () {
  this.route("adminDownloadServerLog", {
    where: "server",
    path: "/admin/status/server-log/:tokenId",
    action() {
      const token = this.params.tokenId;
      const response = this.response;
      const issueDate = SYSTEM_LOG_DOWNLOAD_TOKENS[token];
      delete SYSTEM_LOG_DOWNLOAD_TOKENS[token]; // Clear the token from the in-memory map.
      if (issueDate === undefined || issueDate + 60000 < Date.now()) {
        // Require download to start within 60 seconds of the adminGetServerLogDownloadToken
        // method being called.
        response.writeHead(404, { "Content-Type": "text/plain" });
        return response.end("Invalid server log download token.");
      }

      const logFilePath = SANDSTORM_LOGDIR + "/sandstorm.log";
      // Lazily assume that this logfile won't be "too large" and we can just load it into memory
      const logFileContents = Fs.readFileSync(logFilePath);

      response.writeHead(200, {
        "Content-Length": logFileContents.length,
        "Content-Type": "text/plain",
        "content-Disposition": "attachment;filename=\"sandstorm.log\"",
      });

      return response.end(logFileContents);
    },
  });
});

Meteor.publish("systemStatus", function () {
  // A pseudocollection containing the number of active grain sessions and unique
  // userIds associated with these sessions
  const db = this.connection.sandstormDb;
  if (!db.isAdminById(this.userId)) {
    throw new Meteor.Error(403, "User must be admin to view system status.");
  }

  const _this = this;
  const userIdToSessionHashes = {}; // Maps userId => list of (sha256(sessionId))
  const grainIdToSessionHashes = {}; // Maps grainId => list of (sha256(sessionId))

  let userIdCount = 0;
  let grainIdCount = 0;

  this.added("systemStatus", "globalStatus", {
    activeUsers: userIdCount,
    activeGrains: grainIdCount,
  });

  const query = db.collections.sessions.find();
  const handle = query.observe({
    added(session) {
      const hashedSessionId = hashSessionId(session._id);
      const changed = {};

      // Update userId cache.
      if (session.userId) {
        if (userIdToSessionHashes[session.userId] === undefined) {
          userIdToSessionHashes[session.userId] = [];
          userIdCount = userIdCount + 1;
          changed.activeUsers = userIdCount;
        }

        userIdToSessionHashes[session.userId] =
            _.union(userIdToSessionHashes[session.userId], [hashedSessionId]);
      }

      // Update grainId cache.
      if (grainIdToSessionHashes[session.grainId] === undefined) {
        grainIdToSessionHashes[session.grainId] = [];
        grainIdCount = grainIdCount + 1;
        changed.activeGrains = grainIdCount;
      }

      grainIdToSessionHashes[session.grainId] =
          _.union(grainIdToSessionHashes[session.grainId], [hashedSessionId]);

      if (!_.isEmpty(changed)) {
        _this.changed("systemStatus", "globalStatus", changed);
      }
    },

    removed(session) {
      const hashedSessionId = hashSessionId(session._id);
      const changed = {};

      if (session.userId) {
        userIdToSessionHashes[session.userId] =
            _.without(userIdToSessionHashes[session.userId], hashedSessionId);

        if (userIdToSessionHashes[session.userId].length === 0) {
          delete userIdToSessionHashes[session.userId];
          userIdCount = userIdCount - 1;
          changed.activeUsers = userIdCount;
        }
      }

      grainIdToSessionHashes[session.grainId] =
          _.without(grainIdToSessionHashes[session.grainId], hashedSessionId);

      if (grainIdToSessionHashes[session.grainId].length === 0) {
        delete grainIdToSessionHashes[session.grainId];
        grainIdCount = grainIdCount - 1;
        changed.activeGrains = grainIdCount;
      }

      if (!_.isEmpty(changed)) {
        _this.changed("systemStatus", "globalStatus", changed);
      }
    },
  });

  this.onStop(() => {
    handle.stop();
  });
  this.ready();
});

Meteor.publish("adminDemoUsers", function () {
  // Publishes expiry information about demo accounts to admins, so demo users can be counted
  // clientside and reactively updated.
  const db = this.connection.sandstormDb;
  if (!db.isAdminById(this.userId)) {
    throw new Meteor.Error(403, "User must be admin to view system status.");
  }

  return db.collections.users.find({
    expires: {
      $gt: new Date(),
    },
    loginIdentities: {
      $exists: true,
    },
  }, {
    expires: 1,
    loginIdentities: 1,
  });
});
