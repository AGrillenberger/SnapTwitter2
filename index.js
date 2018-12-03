var express = require('express');
var cors = require('cors');
var util = require('util');
var https = require('https');
var fs = require('fs');
var os = require('os');
const { Client } = require('pg');
var uniqid = require('uniqid');
var md5 = require('md5');

require('dotenv').config();

// Prepare Application
var st = express();
st.locals.title = "Snap!Twitter"; // Application title
st.locals.port = process.env.PORT || 3000;  // Listening port
st.locals.initStopped = process.env.INITSTOPPED || true; // Should streams be stopped immediately after initializing?
st.locals.bufferCap = parseInt(process.env.BUFCAP) || 500; // buffer capacity
st.locals.consoleStatus = true; // show console status
st.locals.consoleStatusUpdateRate = 200; // console status update rate (ms)
st.locals.waitBeforeDisconnect = process.env.WAITBEFOREDISCONNECT || 10000;
st.locals.twitterConsumerKey = process.env.CONSUMERKEY;
st.locals.twitterConsumerSecret = process.env.CONSUMERSECRET;
st.locals.twitterAccessToken = process.env.ACCESSTOKEN;
st.locals.twitterAccessTokenSecret = process.env.ACCESSTOKENSECRET;
st.locals.cookieSecret = process.env.COOKIESECRET;
st.locals.useBasicAuth = process.env.USEBASICAUTH || true;

// Database
var instanceId = uniqid();
const db = new Client({
  connectionString: process.env.DATABASE_URL,
});
db.connect();
db.query("INSERT INTO sysevents(type,instanceid) VALUES ('startup',$1);",[instanceId])

process.on('SIGINT', function() {
  console.log("Caught interrupt signal");
  db.query("INSERT INTO sysevents(type,instanceid) VALUES ('shutdown',$1);",[instanceId], (err,res) => {
    process.exit();
  });
});

// CORS
st.use(cors({origin: "*"}));

// Authentication for app
if(st.locals.useBasicAuth) {
  var users = (process.env.USERS !== undefined) ? JSON.parse(process.env.USERS) : { 'FU-DDI': 'gdi1' }
  var basicAuth = require('express-basic-auth');
  st.use(basicAuth({
    challenge: true,
    unauthorizedResponse: "unauthorized",
    users: users
  }));
}

// if no keys: exit
if(st.locals.twitterConsumerKey == "" || st.locals.twitterConsumerSecret == "") {
  console.log("Twitter consumer key and secret have to be defined!");
  exit(1);
}

// Prepare Twitter API
var Twit = require('twit');
st.locals.T = null;
st.locals.stream = null;
st.locals.lastRequest = Date.now();

// if hardcoded access token: init Twitter API
if(st.locals.twitterAccessToken != "")
  twitterInit();

// prepare OAuth
var OAuth = require('oauth').OAuth;
var auth = null;

// prepare session store
var session = require('express-session');
st.use(session({
  secret: st.locals.cookieSecret,
  name: 'sessionId',
  resave: false,
  saveUninitialized: true,
}));

// Prepare tweet buffer
var RingBuffer = require('ringbufferjs');
st.locals.buf = new RingBuffer(st.locals.bufferCap);

// Console status output
st.locals.tweetsReceived = 0;
st.locals.tweetsRequested = 0;
if(st.locals.consoleStatus) {
  setInterval(function() { process.stdout.write(status()); }, st.locals.consoleStatusUpdateRate);
}

// prepare
// https.createServer({
//   key: fs.readFileSync("server.key"),
//   cert: fs.readFileSync("server.cert")
// }, st)
st.listen(st.locals.port, function () {
  console.error(st.locals.title + ' is running on http://' + os.hostname() + ":" + st.locals.port);
});

// Pause stream when buffer full
setInterval(function() {
  if(st.locals.stream != null && st.locals.stream.streaming && (Date.now() - st.locals.lastRequest) > st.locals.waitBeforeDisconnect && st.locals.buf.size() == st.locals.buf.capacity())
    st.locals.stream.stopStream();
}, 1000);

// check if buffer too empty
setInterval(function() {
  if(st.locals.stream != null && !st.locals.stream.streaming && (st.locals.buf.size() - 1) <= (st.locals.buf.capacity()/2)) {
    st.locals.stream.startStream();
  }
}, 3000);

// HTTP requests
st.use('/snap', express.static('snap'));

st.use('/libraries', express.static('libraries'));

st.use('/status', express.static('statuspage.html'));

st.use('/getStatus', function(req,res) {
  var status = statusJSON();
  status.url = req.get('host');
  res.json(status);
})


st.get('/', function(req, res) {
  res.redirect('/snap');
});

st.get('/twitter/auth', function (req, res) {
  auth = new OAuth(
    'https://api.twitter.com/oauth/request_token',
    'https://api.twitter.com/oauth/access_token',
    st.locals.twitterConsumerKey,
    st.locals.twitterConsumerSecret,
    '1.0',
    req.protocol + '://' + req.get('host') + '/twitter/auth/callback',
    'HMAC-SHA1',
  );
  console.log(req.protocol + '://' + req.get('host') + '/twitter/auth/callback');

  auth.getOAuthRequestToken(function (e, token, secret, results) {
    if (e) {
      console.log("Error getting OAuth request token : " + util.inspect(e));
    }
    st.locals.oauthRequestToken = token;
    st.locals.oauthRequestTokenSecret = secret;
    res.redirect("https://twitter.com/oauth/authorize?oauth_token="+st.locals.oauthRequestToken);
  });
});

st.get('/twitter/auth/callback', function(req, res){
  auth.getOAuthAccessToken(
    st.locals.oauthRequestToken,
    st.locals.oauthRequestTokenSecret,
    req.query.oauth_verifier,
    function(error, oauthAccessToken, oauthAccessTokenSecret, results) {
      if (error) {
        res.send("Error getting OAuth access token : " + util.inspect(error) + "["+oauthAccessToken+"]"+ "["+oauthAccessTokenSecret+"]"+ "["+util.inspect(results)+"]", 500);
      } else {
        st.locals.twitterAccessToken = oauthAccessToken;
        st.locals.twitterAccessTokenSecret = oauthAccessTokenSecret;

        res.redirect("/twitter/auth/success");
      }
    }
  );
});

st.get('/twitter/auth/success', function(req, res) {
  res.send("authed");
  twitterInit();
})

st.get('/twitter/stream/start', function (req, res) {
  if(st.locals.stream == null) {
    res.send("Please authenticate first");
    return;
  }
  st.locals.stream.startStream();
  res.send('stream started');
});

st.get('/twitter/stream/stop', function (req, res) {
  if(st.locals.stream == null) {
    res.send("Please authenticate first");
    return;
  }
  st.locals.stream.stopStream();
  res.send('stream stopped');
});

st.get('/twitter/get/complete', async (req, res) => {
  tweet = await getTweet();
  if(tweet === null) {
    res.status(444);
    res.send("<a href=\"/twitter/auth\">Twitter authentication required</a>");
  } else {
    res.json(tweet);
  }
})

st.get('/twitter/get/attrib/:attrib', async (req, res) => {
  tweet = await getTweet();
  if(tweet === null) {
    res.status(444);
    res.send("");
  } else if(!tweet.hasOwnProperty(req.params.attrib) || req.body[req.params.attrib] == "") {
    res.status(404);
    res.send("");
  } else {
    db.query("INSERT INTO selectedAttributes(attrib,clientid) VALUES ($1,$2);",[req.params.attrib,clientId(req)]);
    res.json(tweet[req.params.attrib]);
  }
})

var bodyParser = require('body-parser');
st.use(bodyParser.json());
st.post('/json/get/attrib/:attrib', function (req, res) {
  var attribPath;
  var attrib;
  if(req.params.attrib.includes(".")) {
    attribPath = req.params.attrib.split(".");
    attrib = attribPath.pop();
  } else {
    attribPath = [];
    attrib = req.params.attrib;
  }
  var path = req.body;
  for (let p of attribPath) {
    if(path != null && !path.hasOwnProperty(p))
      break;
    path = path[p];
  }
  if(path != null && !path.hasOwnProperty(attrib) || path[attrib] == "") {
    res.status(404);
    res.send("err");
  } else {
    res.status(200);
    db.query("INSERT INTO selectedAttributes(attrib,clientid) VALUES ($1,$2);",[req.params.attrib,clientId(req)]);
    if(attrib == "text") {
      path[attrib] = path[attrib].replace("<","(").replace(">",")").replace(/(?:\r\n|\r|\n)/g, "<br />");
    }
    res.json(path[attrib]);
  }
})

st.post('/json/get/geo', function (req, res) {
  if(req.body.geo != null) {
    res.send(req.body.geo.coordinates[0]+";"+req.body.geo.coordinates[1]);
    return;
  }
  var place = req.body.place;
  if(place != null && place.bounding_box != null && place.bounding_box.coordinates != null && place.bounding_box.coordinates[0] != null) {
    //calculate mid of bounding bounding_box
    var c0 = place.bounding_box.coordinates[0][0];
    var c1 = place.bounding_box.coordinates[0][3];
    var m0 = (c0[0] + c1[0])/2;
    var m1 = (c0[1] + c1[1])/2;
    res.send(m1 + ";" + m0);
    return;
  }
})

// Functions
async function getTweet() {
  st.locals.lastRequest = Date.now();
  st.locals.tweetsRequested++;

  if(st.locals.stream == null) {
    return null;
  }

  var result = null
  while(result == null) {
    try{
      result = st.locals.buf.deq();
    } catch (e) {
      //console.log(e);
    }
    await new Promise(sleep => setTimeout(sleep, 300));
  }

  return result;
  //
  // // wait 1s and try again
  // await new Promise(sleep => setTimeout(sleep, 1000));
  // try{
  //   return st.locals.buf.deq();
  // } catch (e) {
  //   return null;
  // }
}

function twitterInit() {
  if(st.locals.twitterAccessToken == "")
    return false;

  st.locals.T = new Twit({
    consumer_key:         st.locals.twitterConsumerKey,
    consumer_secret:      st.locals.twitterConsumerSecret,
    access_token:         st.locals.twitterAccessToken,
    access_token_secret:  st.locals.twitterAccessTokenSecret,
    //app_only_auth:        true,
    timeout_ms:           60*1000,
    strict_ssl:           true,
  });

  // Initialize Twitter stream
  st.locals.stream = st.locals.T.stream('statuses/filter', { locations: [ '-179.999', '-89.999', '179.999', '89.999']});
  st.locals.stream.streaming = true;

  if(st.locals.initStopped) {
    setTimeout(function() {
      st.locals.stream.stopStream();
    }, 1000);
  }

  st.locals.stream.stopStream = function() {
    this.stop();
    this.streaming = false;
    st.locals.lastStop = Date.now();
  }

  st.locals.stream.startStream = async () => {
    if(st.locals.stream.streaming)
      return;

    //console.log(Date.now() - st.locals.lastStop);
    while((Date.now() - st.locals.lastStop) < 5000)
      return;

    st.locals.stream.start();
    st.locals.lastRequest = Date.now();
  }

  // Stream handling
  st.locals.stream.on('tweet', function(tweet) {
    st.locals.buf.enq(tweet);
    st.locals.tweetsReceived++;
  });

  // st.locals.stream.on('limit', function(msg) {
  //   console.error("Twitter >> Limit: ");
  //   console.error(msg);
  // });

  st.locals.stream.on('warning', function(msg) {
    console.error("Twitter >> Warning: " + msg);
  });

  st.locals.stream.on('error', function(msg) {
    console.error("Twitter >> Error: " + msg);
  });

  st.locals.stream.on('disconnect', function(msg) {
    console.error("Twitter >> Disconnect");
  });

  // st.locals.stream.on('connect', function(msg) {
  //   console.error("Twitter >> Connecting");
  // });
  //
  st.locals.stream.on('connected', function(msg) {
    st.locals.stream.streaming = true;
  });
}

function status() {
  var ret = "";
  if(st.locals.stream == null) {
    return "\rStream has not been initialized yet, please go to http://" + os.hostname() + ":" + st.locals.port + "/twitter/auth for authentication.";
    return ret;
  } else {
    return "\rReceived: "+ st.locals.tweetsReceived + " | Requested: "+ st.locals.tweetsRequested + " | Buffer: " + st.locals.buf.size() + "/" + st.locals.buf.capacity() + (st.locals.stream.streaming ? " | streaming" : " | stopped    ");
  }
}

function statusJSON() {
  return {
    init:       st.locals.stream != null,
    hostname:   os.hostname(),
    port:       st.locals.port,
    received:   st.locals.tweetsReceived,
    streaming:  st.locals.stream.streaming,
    processed:  st.locals.tweetsRequested,
    bufferSize: st.locals.buf.size(),
    bufferCap:  st.locals.buf.capacity(),
  };
  return ret;
}

function clientId(req) {
  var client = req.headers['user-agent'] + req.connection.remoteAddress;
  return md5(client);
}
