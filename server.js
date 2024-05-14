const express = require("express"); /* Accessing express module */
const bodyParser = require("body-parser");
const path = require("path");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const fs = require("fs");
const multer = require('multer');
const showdown = require('showdown');
const sharp = require('sharp');
const session = require("express-session");
const cookieParser = require("cookie-parser");

var storage = multer.diskStorage({
    destination: function (req, file, cb) {
      cb(null, './public/uploads')
    },
    filename: function (req, file, cb) {
      cb(null, file.originalname)
    }
});
const upload = multer({ storage: storage, dest: 'public/uploads/' });
let portNumber = 5000;
require("dotenv").config({ path: path.resolve(__dirname, 'credentialsDontPost/.env') }) 
const app = express(); /* app is a request handler function */

app.use(bodyParser.urlencoded({ extended: false }));
app.use(express.static(__dirname + '/public'));
app.set("views", path.resolve(__dirname, "templates"));
app.set("view engine", "ejs");
app.use(cookieParser());
app.use(
  session({
    resave: true,
    saveUninitialized: false,
    secret: process.env.SECRET_STRING, // use .env for secret string
  })
);

const uri = process.env.MONGO_CONNECTION_STRING;

/* Our database and collection */
const databaseAndCollection = {db: "CMSC335DB", collection:"platePal"};
const { MongoClient, ServerApiVersion } = require('mongodb');
const client = new MongoClient(uri, {serverApi: ServerApiVersion.v1 });

const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-pro-vision"});
 
app.listen(portNumber, function (err) {
    if (err) console.log(err);
    console.log(`Server is running at http://localhost:${portNumber}`);
});

// Converts local file information to a GoogleGenerativeAI.Part object.
function fileToGenerativePart(path, mimeType) {
    return {
      inlineData: {
        data: Buffer.from(fs.readFileSync(path)).toString("base64"),
        mimeType
      },
    };
}

app.get("/", (request, response) => { 
    response.render("index"); 
});

app.get("/sign-in", (request, response) => { 
    response.render("sign-in");
});

app.get("/welcome", (request, response) => { // if the user has already signed in
    let user = {name: ""};
    let to_render = "welcome";
    
    if (request.session.name != undefined) {
        user.name = request.session.name;
    } else {
        to_render = "not-signed-in";
    }

    response.render(to_render, user);
});

app.post("/welcome", async (request, response) => { 
    let data = {name: request.body.name, passphrase: request.body.passphrase.trim().toLowerCase()};
    request.session.name = data.name;
    request.session.passphrase = data.passphrase;
    request.session.save();

    try {
        await client.connect(); 
        const userExists = await client.db(databaseAndCollection.db)
                        .collection(databaseAndCollection.collection)
                        .findOne(data);
        
        if (!userExists) {
            newData = {...data, meals: []};
            const result = await client.db(databaseAndCollection.db).collection(databaseAndCollection.collection).insertOne(newData);
            console.log(`User entry created with id ${result.insertedId}`); 
            request.session.id = result.insertedId;
            request.session.save();
        }  
        
        response.render("welcome", data);
    } 
    catch (e) {
        console.error(e);
    } finally {
        await client.close();
    }   
});

app.get("/upload-meal", (request, response) => { 
    let user = {name: ""};
    let to_render = "upload-meal";
    
    if (request.session.name != undefined) {
        user.name = request.session.name;
    } else {
        to_render = "not-signed-in";
    }

    response.render(to_render, user);
});

app.post("/view-meal-results", upload.single('meal-pic'), async (request, response) => { 
    let user = {name: "", passphrase: ""};
    
    if (request.session.name != undefined) {
        user.name = request.session.name;
        user.passphrase = request.session.passphrase;
    } else {
        response.render("not-signed-in");
        return;
    }

    let data = {mealType: request.body.meal_type, mealDate: request.body.meal_date};
    let img = request.file;
    // console.log(img.path);
    // console.log(img.mimetype);
    // console.log(img.size);
    // console.log(img.filename);
    // console.log(data.mealType);

    // generate analysis of meal with Gemini AI API
    const prompt = `Please provide a brief description of how well-balanced this ${data.mealType} is, without the word "sure". 
    In the first sentence, start with the unformatted label "Foods identified: ", and explicitly name what 
    foods you think are pictured, ending with a period. Include a section for pros and cons as well as a section 
    for recommendations on improving the balance. Please also include a healthiness rating out of 10 at the bottom, 
    labelled with "Overall Score:" and no formatting.`;

    const imagePart = fileToGenerativePart(img.path, img.mimetype);

    const result = await model.generateContent([prompt, imagePart]);
    const model_response = result.response;
    const text = model_response.text();
    // console.log(text);

    let converter = new showdown.Converter();
    let html = converter.makeHtml(text); // for viewing on page

    // parse pieces of result with Regex to store for future viewing 
    const foodRegex = /Foods identified:\s*([^.]+)\./;
    const foodMatch = foodRegex.exec(text);
    let foods = "not identified";

    const scoreRegex = /Overall Score:\s*(\d+)\//;
    const scoreMatch = scoreRegex.exec(text);
    let score = "not identified";

    if (foodMatch) {
        foods = foodMatch[1];
        //console.log("Identified foods:", foods);
    } //else {
    //     console.log("No foods identified.");
    // }

    if (scoreMatch) {
        score = scoreMatch[1];
        //console.log("Identified score:", score);
    } //else {
    //     console.log("No score identified.");
    // }

    // upload to MongoDB
    try {
        await client.connect(); 
        const userExists = await client.db(databaseAndCollection.db)
                        .collection(databaseAndCollection.collection)
                        .findOne(user);
        
        if (userExists) {
            // generate thumbnail
            let dir = `public/uploads/${userExists._id.toString()}`;
            if (!fs.existsSync(dir)){
                fs.mkdirSync(dir);
            }

            let thumb_path = `uploads/${userExists._id.toString()}/thumb-` + img.originalname;
            sharp(img.path).resize(130, 130).toFile("public/" + thumb_path, (err, resizeImage) => {
                if (err) {
                    console.log(err);
                } // else {
                //     console.log(resizeImage);
                // }
            });

            let newMealData = {date: data.mealDate, type: data.mealType, foods: foods, healthScore: score,
                        thumbnail: thumb_path};

            const push_result = await client.db(databaseAndCollection.db)
                        .collection(databaseAndCollection.collection)
                        .updateOne(   
                            { _id: userExists._id },
                            { $push: { meals: newMealData } }
                         )
            console.log("Pushed data!");
        }  
        
        response.render("meal-result", {name: user.name, mealResult: html, img: img.filename});
        request.session.lastImg = img.path; 
        request.session.save();
    } 
    catch (e) {
        console.error(e);
    } finally {
        await client.close();
    }   
});

app.get("/past-meals", async (request, response) => {  
    let user = {name: "", passphrase: ""};
    
    if (request.session.name != undefined) {
        user.name = request.session.name;
        user.passphrase = request.session.passphrase;
    } else {
        response.render("not-signed-in");
        return;
    }

    let mealsTable = `<table border=1>
    <thead>
      <tr>
          <th>Date</th>
          <th>Meal Type</th>
          <th>Foods</th>
          <th>Health Score</th>
          <th>Image</th>
      </tr>
    </thead>
    <tbody>`;

    try {
        await client.connect();
        const result = await client.db(databaseAndCollection.db)
            .collection(databaseAndCollection.collection)
            .findOne(user);

        const meals = result.meals;

        meals.forEach(elt => {
            mealsTable += `<tr>
                <td data-label="Date">${elt.date}</td>
                <td data-label="Meal Type">${elt.type}</td>
                <td data-label="Foods">${elt.foods}</td>
                <td data-label="Health Score">${elt.healthScore}/10</td>
                <td data-label="Image"><img src="${elt.thumbnail}" class="thumb"/></td>
              </tr>`
          });
        
        mealsTable += "</tbody></table>";
        
        if (meals.length == 0) {
            mealsTable = "No meals have been entered yet!<br>";
        }

        response.render("past-meals", {name: user.name, mealsTable: mealsTable});
    } 
    catch (e) {
        console.error(e);
    } finally {
        await client.close();
    }
});
