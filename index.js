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
db.query("INSERT INTO sysevents(type,instanceid) VALUES ('startup',$1);",[instanceId]);

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
  var users = (process.env.USERS !== undefined) ? JSON.parse(process.env.USERS) : { 'demo': 'demo' };
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
var Twitter = {};
Twitter.T = null;
Twitter.stream = null;
Twitter.lastRequest = Date.now()

// if hardcoded access token: init Twitter API
if(st.locals.twitterAccessToken != "")
  twitterInit();

// Chunked streaming APIs
var chunked = require("chunked-http");
var Chunked = {};
Chunked.streams = {};

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

// Prepare buffers
var RingBuffer = require('ringbufferjs');
Twitter.buffer = new RingBuffer(st.locals.bufferCap);
Chunked.buffers = {}

// Console status output
Twitter.tweetsReceived = 0;
Twitter.tweetsRequested = 0;
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
  if(Twitter.stream != null && Twitter.stream.streaming && (Date.now() - Twitter.lastRequest) > st.locals.waitBeforeDisconnect && Twitter.buffer.size() == Twitter.buffer.capacity())
    Twitter.stream.stopStream();
}, 1000);

// check if buffer too empty
setInterval(function() {
  if(Twitter.stream != null && !Twitter.stream.streaming && (Twitter.buffer.size() - 1) <= (Twitter.buffer.capacity()/2)) {
    Twitter.stream.startStream();
  }
}, 3000);

// HTTP requests
var bodyParser = require('body-parser');
st.use(bodyParser.urlencoded({ extended: true }));
st.use(bodyParser.json());

st.use('/snap', express.static('snap'));

st.use('/libraries', express.static('libraries'));

st.use('/status', express.static('statuspage.html'));

st.use('/getStatus', function(req,res) {
  var status = statusJSON();
  status.url = req.get('host');
  res.json(status);
});


st.get('/', function(req, res) {
  res.redirect('/snap');
});

st.post('/chunkedstream/:name/start', function (req, res) {
  // expects url as postdata
  url = req.body.url;
  if(!url || url.length < 10) {
    res.status(404);
    res.send("invalid url (should be submitted via POST)");
    return false;
  }

  // check if name is not yet in use
  name = req.params.name;
  if(typeof name === "undefined" || name === null || Chunked.streams[name]) {
    res.status(404);
    res.send("name already in use or invalid");
    return false;
  }

  Chunked.buffers[name] = new RingBuffer(10);
  Chunked.streams[name] = chunked.request(url, function(data) {
    Chunked.buffers[name].enq(data);
  });

  res.send("OK");
});

st.get('/chunkedstream/:name/stop', function (req, res) {
  name = req.params.name;
  if(typeof name === "undefined" || name === null || !Chunked.streams[name]) {
    res.status(404);
    res.send("name not in use or invalid");
    return false;
  }

  chunked.abort(Chunked.streams[name]);
  Chunked.buffers[name] = null;
  Chunked.streams[name] = null;

  res.send("OK");
});

st.get('/chunkedstream/:name/get', async (req, res) => {
  if(typeof name === "undefined" || name === null || !Chunked.streams[name]) {
    res.status(404);
    res.send("name not in use or invalid");
    return false;
  }

  var result = null
  var timeout = 300;
  while(result == null) {
    try{
      timeout *= 2;
      result = Chunked.buffers[name].deq();
      if(timeout > 4800)
        break;
    } catch (e) {
      //console.log(e);
    }
    await new Promise(sleep => setTimeout(sleep, timeout));
  }

  res.send(result);
});

st.get('/twitter/auth', function (req, res) {
  auth = new OAuth(
    'https://api.twitter.com/oauth/request_token',
    'https://api.twitter.com/oauth/access_token',
    st.locals.twitterConsumerKey,
    st.locals.twitterConsumerSecret,
    '1.0',
    req.protocol + '://' + req.get('host') + '/twitter/auth/callback',
    'HMAC-SHA1'
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
});

st.get('/twitter/stream/start', function (req, res) {
  if(Twitter.stream == null) {
    res.send("Please authenticate first");
    return;
  }
  Twitter.stream.startStream();
  res.send('stream started');
});

st.get('/twitter/stream/stop', function (req, res) {
  if(Twitter.stream == null) {
    res.send("Please authenticate first");
    return;
  }
  Twitter.stream.stopStream();
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

    // stip quotation marks of attributes
    found = path[attrib].match(/\"(.*)\"/);
    if(found === null && found.length == 2)
      res.json(found[1]);

    res.json(path[attrib]);
  }
})

st.post('/json/get/geo', function (req, res) {
  if(req.body.geo != null) {
    res.send(req.body.geo.coordinates[0]+";"+req.body.geo.coordinates[1]);
    return;
  }
  db.query("INSERT INTO selectedAttributes(attrib,clientid) VALUES ('geo',$1);",[clientId(req)]);
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
  Twitter.lastRequest = Date.now();
  Twitter.tweetsRequested++;

  if(Twitter.stream == null) {
    return null;
  }

  var result = null
  while(result == null) {
    try{
      result = Twitter.buffer.deq();
    } catch (e) {
      //console.log(e);
    }
    await new Promise(sleep => setTimeout(sleep, 300));
  }

  return result;
}

function twitterInit() {
  if(st.locals.twitterAccessToken == "")
    return false;

  Twitter.T = new Twit({
    consumer_key:         st.locals.twitterConsumerKey,
    consumer_secret:      st.locals.twitterConsumerSecret,
    access_token:         st.locals.twitterAccessToken,
    access_token_secret:  st.locals.twitterAccessTokenSecret,
    //app_only_auth:        true,
    timeout_ms:           60*1000,
    strict_ssl:           true,
  });

  // Initialize Twitter stream
  Twitter.stream = Twitter.T.stream('statuses/filter', { locations: [ '-179.999', '-89.999', '179.999', '89.999']});
  Twitter.stream.streaming = true;

  if(st.locals.initStopped) {
    setTimeout(function() {
      Twitter.stream.stopStream();
    }, 1000);
  }

  Twitter.stream.stopStream = function() {
    this.stop();
    this.streaming = false;
    st.locals.lastStop = Date.now();
  }

  Twitter.stream.startStream = async () => {
    if(Twitter.stream.streaming)
      return;

    //console.log(Date.now() - st.locals.lastStop);
    while((Date.now() - st.locals.lastStop) < 5000)
      return;

    Twitter.stream.start();
    Twitter.lastRequest = Date.now();
  }

  // Stream handling
  Twitter.stream.on('tweet', function(tweet) {
    Twitter.buffer.enq(tweet);
    Twitter.tweetsReceived++;
  });

  // Twitter.stream.on('limit', function(msg) {
  //   console.error("Twitter >> Limit: ");
  //   console.error(msg);
  // });

  Twitter.stream.on('warning', function(msg) {
    console.error("Twitter >> Warning: " + msg);
  });

  Twitter.stream.on('error', function(msg) {
    console.error("Twitter >> Error: " + msg);
  });

  Twitter.stream.on('disconnect', function(msg) {
    console.error("Twitter >> Disconnect");
  });

  // Twitter.stream.on('connect', function(msg) {
  //   console.error("Twitter >> Connecting");
  // });
  //
  Twitter.stream.on('connected', function(msg) {
    Twitter.stream.streaming = true;
  });
}

function status() {
  var ret = "";
  if(Twitter.stream == null) {
    return "\rStream has not been initialized yet, please go to http://" + os.hostname() + ":" + st.locals.port + "/twitter/auth for authentication.";
    return ret;
  } else {
    return "\rReceived: "+ Twitter.tweetsReceived + " | Requested: "+ Twitter.tweetsRequested + " | Buffer: " + Twitter.buffer.size() + "/" + Twitter.buffer.capacity() + (Twitter.stream.streaming ? " | streaming" : " | stopped    ");
  }
}

function statusJSON() {
  return {
    init:       Twitter.stream != null,
    hostname:   os.hostname(),
    port:       st.locals.port,
    received:   Twitter.tweetsReceived,
    streaming:  Twitter.stream.streaming,
    processed:  Twitter.tweetsRequested,
    bufferSize: Twitter.buffer.size(),
    bufferCap:  Twitter.buffer.capacity(),
  };
  return ret;
}

function clientId(req) {
  var client = req.headers['user-agent'] + req.connection.remoteAddress;
  return md5(client);
}
