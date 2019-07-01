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

st.use('/snap/SnapTwitter/st2-project.xml', function(req, res) {
  file = fs.readFileSync('snap/SnapTwitter/st2-project-tpl.xml','utf8');
  blocks = fs.readFileSync('snap/SnapTwitter/st2-blocks.xml','utf8');
  blocks = blocks.replace('<blocks app="Snap!Twitter 2.0" version="1">',"").replace('</blocks>',"");
  file = file.replace("%%%ST2-BLOCKS-GO-HERE%%%", blocks);

  lang = req.query.lang;
  if(typeof lang == "undefined" || lang == "" || lang == "en") {
    repl = [
      ["%%%headGet%%%", "Get a tweet from twitter"],
      ["%%%blockGet%%%", "Click block to execute"],
      ["%%%headTable%%%", "Get a better overview on a tweet"],
      ["%%%blockTable%%%", "Drag the 'get single tweet' block here and then click the outer block"],
      ["%%%headAttr%%%", "Read an attribute from a tweet"],
      ["%%%blockAttr%%%", "Enter an attribute name (e. g. text, id or user.name) into the first field and drag the tweet onto the cloud"],
      ["%%%headForeach%%%", "Show the text of all tweets on the stage"],
      ["%%%blockForeach%%%", "Here again, the cloud needs to be replaced. As the for-each-block continuously reads the tweets, we do not need to use the get-single-tweet-block but instead just drag the orange tweet-variable from the outer block onto the cloud to use it."],
      ["%%%headMap%%%", "Show the tweets on a map"],
      ["%%%blockMap%%%", "This block shows a marker on the map. It needs a position, which can be read from a tweet using 'get geo from tweet' block. You can customize the marker for example by using other colors. And you can also show a text when you click the marker on the stage. At the moment it just says 'hello' - change it to the tweets text!"],
      ["%%%headChart%%%", "For visualizing e. g. statistics, we can use charts"],
      ["%%%blockChart%%%", "This C-shaped block is used for defining the chart. Inside the C, we will place the chart elements:"],
      ["%%%blockChartExample1%%%", "for example, a bar chart with a line at y=5"],
      ["%%%blockChartExample2%%%", "or a combined line and bar chart"],
      ["%%%blockChartExample3%%%", "or a pie chart"],
      ["%%%headEnd%%%", "And of course, all these possibilites can be combined - just try, for example, to visualize the most common languages on twitter using both, a map and a chart."]
    ];
  } else if(lang == "de") {
    repl = [
      ["%%%headGet%%%", "Tweet von Twitter abfragen"],
      ["%%%blockGet%%%", "Block zum ausführen anklicken"],
      ["%%%headTable%%%", "Bessere Übersicht über einen Tweet"],
      ["%%%blockTable%%%", "Das leere Feld muss mit dem 'einzelnen Tweet abfragen'-Block gefüllt werden"],
      ["%%%headAttr%%%", "Attribut eines Tweets auslesen"],
      ["%%%blockAttr%%%", "In das erste Feld den Attributnamen (z. B. text, id or user.name) eingeben und den Tweet auf die Wolke ziehen"],
      ["%%%headForeach%%%", "Alle Tweettexte auf der Bühne anzeigen"],
      ["%%%blockForeach%%%", "Auch hier muss die Wolke durch den Tweet ersetzt werden. Da der für-alle-Block aber die Tweets schon ausliest, ist der 'einzelnen Tweet auslesen'-Block hier ungünstig, stattdessen kann die orange Tweet-Variable aus dem Schleifenkopf auf die Wolke gezogen werden."],
      ["%%%headMap%%%", "Tweets auf einer Karte anzeigen"],
      ["%%%blockMap%%%", "Dieser Block erzeugt einen Pin auf einer Karte. Er benötigt eine Position für diesen, die aus einem Tweet mit dem 'Geodaten aus Tweet'-Block ausgelesen werden können. Der Marker kann durch Farben angepasst werden, außerdem kann beim Anklicken ein Text angezeigt werden. Gerade wird nur 'hallo' angezeigt - ändere dies, damit der Tweettext angezeigt wird."],
      ["%%%headChart%%%", "Visualisierung von Statistiken"],
      ["%%%blockChart%%%", "Dieser C-förmige Block wird genutzt, um das Diagramm zu initialisieren. Innerhalb des C werden die Diagrammelemente definiert:"],
      ["%%%blockChartExample1%%%", "zum Beispiel ein Balkendiagramm mit einer Linie bei y=5"],
      ["%%%blockChartExample2%%%", "oder ein kombiniertes Balken- und Liniendiagramm"],
      ["%%%blockChartExample3%%%", "oder ein Tortendiagramm"],
      ["%%%headEnd%%%", "Natürlich können alle Möglichkeiten kombiniert werden - versuche doch, die meistverwendeten Sprachen sowohl mit einer Karte als auch einem Diagramm zu visualisieren."]
    ];
  }

  file = file.replaceMultiple(repl);

  res.send(file);
});

st.use('/snap', express.static('snap'));

st.use('/libraries', express.static('libraries'));

st.use('/status', express.static('statuspage.html'));

st.use('/getStatus', function(req,res) {
  var status = statusJSON();
  status.url = req.get('host');
  res.json(status);
});

st.use('/www/resources', express.static('website/resources'));

st.use('/www/de', express.static('website/de'));

st.use('/www/en', express.static('website/en'));

st.use('/www', function(req, res) {
  lang = req.acceptsLanguages("de", "de-DE", "de-AT", "de-CH", "en", "en-US", "en-UK", "en-AU");
  if(lang.toLowerCase().startsWith("de")) {
    res.redirect("/www/de")
  } else {
    res.redirect("/www/en")
  }
});

st.get('/', function(req, res) {
  res.redirect('/www');
});

st.get('/twitter/demo', function(req, res) {
  res.send(demoTweet());
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

// Authentication for app (only for enpoints after this point!)
if(st.locals.useBasicAuth) {
  var users = (process.env.USERS !== undefined) ? JSON.parse(process.env.USERS) : { 'demo': 'demo' };
  var basicAuth = require('express-basic-auth');
  st.use(basicAuth({
    unauthorizedResponse: "unauthorized",
    users: users
  }));
}


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
    if(found !== null && found.length == 2)
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

// gets an array [ [0 => "find1", 1 => "repl1"], [...], ... ]
String.prototype.replaceMultiple = function(arr) {
  myString = this;
  for(var fr of arr) {
    myString = myString.replace(fr[0], fr[1]);
  }

  return myString;
}

function demoTweet() {
  texts = [
    "demo tweet",
    "test tweet",
    "another test",
    "just a test",
    "tweet text",
    "lorem ipsum",
    "this is a test",
    "demo mode"
  ];

  text = texts[Math.floor(Math.random() * texts.length)];
  coord1 = Math.random() * 85 * ((Math.random() < 0.5) ? 1 : -1);
  coord2 = Math.random() * 180 * ((Math.random() < 0.5) ? 1 : -1);
  date = new Date();
  id = Math.floor(Math.random() * (999999999999999999-(-111111111111111111) + (-111111111111111111)));

  return `{
  "created_at": "${date}",
  "id_str": "${id}",
  "text": "${text}",
  "user": {
    "id": 123,
    "name": "demo",
    "screen_name": "demo",
    "location": "somewhere",
    "url": "https:\/\/snaptwitter.dataliteracy.education\/",
    "description": "XYZ"
  },
  "place": {
  },
  "entities": {
    "hashtags": [
    ],
    "urls": [
      {
        "url": "XXX",
        "unwound": {
          "url": "XXX",
          "title": "ABC"
        }
      }
    ],
    "user_mentions": [
    ]
  },
  "geo": {
    "type": "Point",
    "coordinates": [
      ${coord1},
      ${coord2}
    ]
  }
}`;
}
